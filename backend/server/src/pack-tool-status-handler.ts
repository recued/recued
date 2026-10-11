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
  OWNER_TOOL_VERSION_SCOPE,
  RpcError,
  cliInstallSystemOf,
  cliToolFromConnectorRuntime,
  cliToolPolicyOfRuntime,
  effectiveToolVersionOutside,
  readOwnerToolVersionRow,
  renderInstallHints,
  type HandlerSlice,
  type IngredientManifest,
  type PackToolStatus,
  type PackToolStatusEntry,
  type PacksToolStatusRequest,
  type PacksToolStatusResult,
  type ServerRpcRegistry,
} from '@recued/contracts';

import { createCliBinaryPathResolver } from './cli-binary-reachability.js';
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
}

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

  const toolOf = async (catalog: string): Promise<PackToolStatus | undefined> => {
    const manifest = deps.getManifest(catalog);
    const runtime = manifest?.surfaces?.connector?.runtime;
    const binary = cliToolFromConnectorRuntime(runtime);
    if (runtime === undefined || binary === undefined) return undefined;
    const { tool_version, tool_install } = cliToolPolicyOfRuntime(runtime);
    const version = tool_version?.version;
    const probe = tool_version?.probe;
    const { commands, docs } = renderInstallHints(tool_install, system, version?.tested);
    const base = { catalog, binary, install: commands, docs };
    if (version === undefined || probe === undefined) {
      // R5 — no range: looked up on PATH, never run.
      return { ...base, state: resolveBinary(binary) !== undefined ? 'ready' : 'missing' };
    }
    // The probe must name the program the pack's actions run, as the executor
    // holds it before a run; one that names another is never started.
    const ownProbe = probe[0] === binary;
    if (request.recheck === true && ownProbe) deps.toolStatus.forget(binary);
    const report: CliToolStatusReport = ownProbe
      ? await deps.toolStatus.check({ probe, tested: version.tested })
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

  const toolOrNone = async (catalog: string): Promise<PackToolStatus | undefined> => {
    try {
      return await toolOf(catalog);
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
    tools: (await Promise.all(packIngredientIds(store, row.pack_slug).map(toolOrNone)))
      .filter((tool): tool is PackToolStatus => tool !== undefined),
  })))).filter((entry) => entry.tools.length > 0);
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
