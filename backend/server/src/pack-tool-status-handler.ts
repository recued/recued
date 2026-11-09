/** D-321 slice 3 — `packs.tool_status`: whether each installed pack's programs
 *  are ready on this server.
 *
 *  🔑 RE-DERIVED PER CALL, LIKE `packs.unrunnable`, AND FOR THE SAME REASON: a
 *  tool that is missing, broken or a version the pack was not tested with is a
 *  STANDING CONDITION, true until the owner changes the server. Nothing here is
 *  stored. The version read behind it is cached by the shared `CliToolStatus`
 *  (until the binary or PATH changes, an hour at most), so the pack list and a
 *  run before an action see the same answer, and "Check again" (`recheck`)
 *  drops the cached reads of the pack's tools first.
 *
 *  - A tool whose pack declares a range is probed with the pack's own
 *    version-only probe. One that declares none is looked up on PATH and never
 *    run (R5), so the packs without a range cost no process.
 *  - Every pack's tools are read at once, not one pack after another: a probe
 *    may take its full limit, and the pack list waits on none of them in turn.
 *  - The install commands are written for THIS server's system, which the
 *    webclient cannot know, from hints checked again before they are shown.
 *  - A catalog's values are read through `cliToolPolicyOfRuntime`, which checks
 *    a stored catalog again; and one tool that cannot be read is left out
 *    rather than fail the answer for every pack.
 *
 *  ⚠ Read-only and per-pair, behind the `packs.` reserved prefix, so an
 *  MCP-channel agent cannot enumerate it. */

import {
  OWNER_TOOL_PATH_SCOPE,
  OWNER_TOOL_VERSION_SCOPE,
  RpcError,
  cliInstallSystemOf,
  cliToolFromConnectorRuntime,
  cliToolPolicyOfRuntime,
  effectiveToolVersionOutside,
  readOwnerToolVersionRow,
  renderInstallHints,
  type BulkPackManifest,
  type CliToolState,
  type HandlerSlice,
  type IngredientManifest,
  type PackToolStatus,
  type PackToolStatusEntry,
  type PacksToolStatusRequest,
  type PacksToolStatusResult,
  type ServerRpcRegistry,
} from '@recued/contracts';

import { decomposeComposition } from '@recued/ingredient-authoring';

import { createCliBinaryPathResolver } from './cli-binary-reachability.js';
import { ownerLocationFolders, ownerLocationFor, ownerLocationSource, unreachableInterpreter } from './cli-owner-location.js';
import { programOutsidePath, type ProgramOutsidePath } from './cli-path-diagnosis.js';

/** D-321 — where a program is read from: the owner's location, or its name on
 *  the PATH. */
interface Located {
  target: string;
  path?: string;
  folders?: string[];
  /** D-346 — the catalog the location was set on, when it is not this one. */
  from?: string;
}
import {
  brokenProbeDetail,
  unreadableProbeDetail,
  type CliToolStatus,
  type CliToolStatusReport,
} from './cli-tool-status.js';
import { listInstalledPacks, packIngredientIds } from './pack-inventory.js';
import type { ContractStore } from './storage/contract-store.js';
import { ownerFacingPackSlug } from './unrunnable-pack-notice.js';
import type { WsClient } from './ws-server.js';

export interface PackToolStatusRpcDeps {
  /** The installed-pack inventory and the owner's per-tool choices. Absent
   *  (a dbless harness) ⇒ no packs. */
  getContractStore: () => ContractStore | undefined;
  /** The installed catalogs, by slug: the live manifest registry. */
  getManifest: (slug: string) => IngredientManifest | null;
  /** The server's one readiness service, shared with the executor's check. */
  toolStatus: CliToolStatus;
  /** Where a tool with no range is looked up, never run. Default: the PATH
   *  walk an action's launch makes. */
  resolveBinary?: (binary: string) => string | undefined;
  /** Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Where a missing program sits outside the server's PATH, if it does.
   *  Default: `programOutsidePath`, which looks in the usual install folders. */
  findOutsidePath?: (binary: string) => ProgramOutsidePath | undefined;
  /** D-321 C1 — a pack's manifest by slug, installed or not (the shipped pack, else
   *  the marketplace's), so a pack's page says before install which program it
   *  runs and whether this server has it. Absent: only installed packs answer. */
  resolvePackManifest?: (slug: string) => BulkPackManifest | null;
}

/** D-321 C1 — the cli catalogs a pack that is not installed would install, by
 *  slug: its compositions, decomposed as an install decomposes them. One that does
 *  not decompose is left out, as an install would refuse it. */
const catalogsOfManifest = (manifest: BulkPackManifest): Map<string, IngredientManifest> => {
  const out = new Map<string, IngredientManifest>();
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    const composition = content.composition;
    const decompose = decomposeComposition[composition.schema_version];
    if (decompose === undefined) continue;
    try {
      const catalog = decompose(composition).catalog as IngredientManifest | undefined;
      if (catalog !== undefined && typeof catalog.slug === 'string') out.set(catalog.slug, catalog);
    } catch {
      // Not one an install would accept: nothing to say about it here.
    }
  }
  return out;
};

const readRequest = (args: unknown): PacksToolStatusRequest => {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError('bad_request', 'packs.tool_status: args must be an object');
  }
  const { pack_slug, recheck } = args as Record<string, unknown>;
  if (pack_slug !== undefined && (typeof pack_slug !== 'string' || pack_slug.length === 0)) {
    throw new RpcError('bad_request', 'packs.tool_status: pack_slug, when present, must be a non-empty string');
  }
  if (recheck !== undefined && typeof recheck !== 'boolean') {
    throw new RpcError('bad_request', 'packs.tool_status: recheck, when present, must be true or false');
  }
  return {
    ...(pack_slug !== undefined ? { pack_slug } : {}),
    ...(recheck !== undefined ? { recheck } : {}),
  };
};

export const handlePacksToolStatus = async (
  deps: PackToolStatusRpcDeps,
  args: unknown,
): Promise<PacksToolStatusResult> => {
  const request = readRequest(args);
  const system = cliInstallSystemOf(deps.platform ?? process.platform);
  const store = deps.getContractStore();
  if (store === undefined) return { system, packs: [] };
  const resolveBinary = deps.resolveBinary ?? createCliBinaryPathResolver();
  // D-321 — a program the server cannot find may still be installed, in a folder
  // its PATH leaves out (a LaunchAgent's PATH has no Homebrew). Then the page says
  // where it is and how to fix the PATH, rather than offering to install it again.
  const findOutside = deps.findOutsidePath ?? ((binary: string) => programOutsidePath(binary));
  const outsideOf = (state: CliToolState, binary: string): Partial<ProgramOutsidePath> =>
    (state === 'missing' ? { ...findOutside(binary) } : {});

  // D-321 — the location the owner set for a catalog's program, while it
  // applies: its state is that file's, read as a run reads it, with the same
  // folders at the end of the probe's PATH (`cli-owner-location.ts`).
  const platform = deps.platform ?? process.platform;
  const locate = (catalog: string, binary: string): Located => {
    const readRow = (id: string): unknown => store?.get(OWNER_TOOL_PATH_SCOPE, [id])?.value;
    const path = ownerLocationFor(readRow, catalog, binary, platform);
    if (path === undefined) return { target: binary };
    // D-346 — a Kitchen copy running its original's location says so: clearing a
    // row the copy does not have would change nothing.
    const from = ownerLocationSource(readRow, catalog);
    return { target: path, path, folders: ownerLocationFolders(path), ...(from !== catalog ? { from } : {}) };
  };

  /** R5 — no range: looked up, never run. A set location is that file, and a
   *  script whose interpreter nothing reaches would only fail inside `env`. */
  const stateWithoutRange = (at: Located): Pick<PackToolStatus, 'state' | 'detail'> => {
    if (resolveBinary(at.target) === undefined) return { state: 'missing' };
    const interpreter = at.path === undefined ? undefined : unreachableInterpreter(at.path, at.folders ?? []);
    if (interpreter === undefined) return { state: 'ready' };
    return { state: 'broken', detail: `It starts with ${interpreter}, which the server cannot find on its PATH or beside it.` };
  };

  const toolOf = async (
    catalog: string,
    manifest: IngredientManifest | null = deps.getManifest(catalog),
  ): Promise<PackToolStatus | undefined> => {
    const runtime = manifest?.surfaces?.connector?.runtime;
    const binary = cliToolFromConnectorRuntime(runtime);
    if (runtime === undefined || binary === undefined) return undefined;
    const { tool_version, tool_install } = cliToolPolicyOfRuntime(runtime);
    const version = tool_version?.version;
    const probe = tool_version?.probe;
    const { commands, docs } = renderInstallHints(tool_install, system, version?.tested);
    const base = { catalog, binary, install: commands, docs };
    const at = locate(catalog, binary);
    const located = at.path === undefined ? {} : { owner_path: at.path, ...(at.from !== undefined ? { owner_path_from: at.from } : {}) };
    if (version === undefined || probe === undefined) {
      const known = stateWithoutRange(at);
      return { ...base, ...known, ...located, ...(at.path === undefined ? outsideOf(known.state, binary) : {}) };
    }
    // The probe must name the program the pack's actions run, as the executor
    // holds it before a run; one that names another is never started.
    const ownProbe = probe[0] === binary;
    if (request.recheck === true && ownProbe) {
      deps.toolStatus.forget(binary);
      if (at.path !== undefined) deps.toolStatus.forget(at.path);
    }
    const report: CliToolStatusReport = ownProbe
      ? await deps.toolStatus.check({
        probe: [at.target, ...probe.slice(1)],
        tested: version.tested,
        ...(at.folders !== undefined ? { extraPath: at.folders } : {}),
      })
      : { state: 'unreadable', binary, probe_result: { kind: 'not_run' } };
    const owner = readOwnerToolVersionRow(store.get(OWNER_TOOL_VERSION_SCOPE, [catalog])?.value);
    const effective = effectiveToolVersionOutside(version, owner);
    const result = report.probe_result;
    const detail = result?.kind === 'broken'
      ? brokenProbeDetail(probe, result)
      : result?.kind === 'unreadable' || result?.kind === 'not_run'
        ? unreadableProbeDetail(binary, probe, result)
        : undefined;
    return {
      ...base,
      state: report.state,
      ...located,
      ...(at.path === undefined ? outsideOf(report.state, binary) : {}),
      ...(result?.kind === 'version' ? { version: result.version } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(report.checked_at !== undefined ? { checked_at: report.checked_at } : {}),
      tested: { ...version.tested },
      outside: effective.outside,
      pack_outside: version.outside,
      ...(owner !== undefined ? { owner_outside: owner.outside } : {}),
      ...(effective.stale_owner_choice ? { stale_owner_choice: true as const } : {}),
    };
  };

  const toolOrNone = async (
    catalog: string,
    manifest?: IngredientManifest,
  ): Promise<PackToolStatus | undefined> => {
    try {
      return await (manifest === undefined ? toolOf(catalog) : toolOf(catalog, manifest));
    } catch {
      return undefined;
    }
  };
  const wanted = listInstalledPacks(store)
    .map((row) => ({ row, slug: ownerFacingPackSlug(store, row.pack_slug) }))
    .filter(({ row, slug }) =>
      request.pack_slug === undefined || request.pack_slug === slug || request.pack_slug === row.pack_slug);
  const packs: PackToolStatusEntry[] = (await Promise.all(wanted.map(async ({ row, slug }) => ({
    slug,
    tools: (await Promise.all(packIngredientIds(store, row.pack_slug).map((id) => toolOrNone(id))))
      .filter((tool): tool is PackToolStatus => tool !== undefined),
  })))).filter((entry) => entry.tools.length > 0);
  // D-321 C1 — one pack asked for by its page, and not installed: its programs,
  // read from the manifest an install would use, checked as an installed pack's
  // are. Never for the list, which reads installed packs only.
  if (request.pack_slug !== undefined && wanted.length === 0 && deps.resolvePackManifest !== undefined) {
    let manifest: BulkPackManifest | null = null;
    try {
      manifest = deps.resolvePackManifest(request.pack_slug);
    } catch {
      manifest = null;
    }
    if (manifest !== null) {
      const catalogs = catalogsOfManifest(manifest);
      const tools = (await Promise.all([...catalogs].map(([id, catalog]) => toolOrNone(id, catalog))))
        .filter((tool): tool is PackToolStatus => tool !== undefined);
      if (tools.length > 0) packs.push({ slug: request.pack_slug, tools, installed: false });
    }
  }
  return { system, packs };
};

type PacksToolStatusMethods = 'packs.tool_status';

export const makePackToolStatusHandlers = (
  deps: PackToolStatusRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PacksToolStatusMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['packs.tool_status'],
    handlers: {
      'packs.tool_status': async (args) => handlePacksToolStatus(deps, args),
    },
  };
};
