/** D-174 Runs/Audit read-RPC seam.
 *
 *  `execution.list` and `execution.get` are local-UI / paired-client
 *  reads over existing audit/checkpoint/link stores. The detail shape is
 *  intentionally projected: no audit `config_snapshot`, no checkpoint
 *  `step_state`, and no arg overrides or raw source token ids leave the
 *  server.
 */

import type Database from 'better-sqlite3';
import {
  ACTORS,
  RUN_ANCHOR_STATUSES,
  RpcError,
  isCliFailureDetail,
  provenanceAttributionFromSource,
  renderActorLabel,
  sanitizeTimelineOriginFilter,
  type Actor,
  type CliFailureReason,
  type Commit,
  type Checkpoint,
  type CommitStatus,
  type ExecutionGetRequest,
  type ExecutionGetResponse,
  type ExecutionListCursor,
  type ExecutionListQuery,
  type ExecutionListResponse,
  type HandlerSlice,
  type PolicyResult,
  type RunGatewayCallDecision,
  type RunGatewayCallTraceEntry,
  type RunApprovalCheckpoint,
  type RunApprovalOutcome,
  type RunAuditSummary,
  type RunDetail,
  type RunFeedRow,
  type RunOrigin,
  type RunProvenanceLink,
  type RunAnchorStatus,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type {
  AuditEntry,
  AuditExportLinkRow,
  AuditLogStore,
  CheckpointStore,
  CommitStore,
} from '@recued/storage';

import {
  makeServerExportSource,
  type AuditExportRpcDeps,
} from './audit-export-handler.js';
import type { WsClient } from './ws-server.js';

export interface ExecutionFeedRpcDeps {
  db: Database.Database;
  auditLog: AuditLogStore;
  checkpointStore: CheckpointStore;
  commitStore: CommitStore;
  serverInstanceId: string;
}

interface ValidatedExecutionListQuery {
  status?: readonly RunAnchorStatus[];
  origin?: readonly Actor[];
  recipe_id?: string;
  trigger_source?: string;
  since?: number;
  until?: number;
  limit: number;
  cursor?: ExecutionListCursor;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_ANCHOR_STATUSES);
const ACTOR_SET: ReadonlySet<string> = new Set(ACTORS);

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'execution rpc requires a registered paired client',
      401,
    );
  }
};

const asObject = (method: string, raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object') {
    throw new RpcError('bad_request', `${method}: args must be an object`, 400);
  }
  return raw as Record<string, unknown>;
};

const clampLimit = (limit: unknown): number => {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.floor(limit));
};

const optionalString = (
  method: string,
  value: unknown,
  name: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${method}: ${name} must be a non-empty string`, 400);
  }
  return value;
};

const optionalFiniteNumber = (
  method: string,
  value: unknown,
  name: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError('bad_request', `${method}: ${name} must be a finite number`, 400);
  }
  return value;
};

const optionalCursor = (
  method: string,
  value: unknown,
): ExecutionListCursor | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new RpcError('bad_request', `${method}: cursor must be an object`, 400);
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.last_started_at !== 'number'
    || !Number.isFinite(obj.last_started_at)
    || typeof obj.last_run_id !== 'string'
    || obj.last_run_id.length === 0
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: cursor must carry last_started_at and last_run_id`,
      400,
    );
  }
  return {
    last_started_at: obj.last_started_at,
    last_run_id: obj.last_run_id,
  };
};

const optionalStatusFilter = (
  method: string,
  value: unknown,
): readonly RunAnchorStatus[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RpcError('bad_request', `${method}: status must be an array`, 400);
  }
  const out: RunAnchorStatus[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !RUN_STATUS_SET.has(item)) {
      throw new RpcError('bad_request', `${method}: unknown status '${String(item)}'`, 400);
    }
    out.push(item as RunAnchorStatus);
  }
  return out.length > 0 ? out : undefined;
};

const optionalActorFilter = (value: unknown): readonly Actor[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const actors = value.filter((item): item is Actor =>
    typeof item === 'string' && ACTOR_SET.has(item),
  );
  return sanitizeTimelineOriginFilter(actors);
};

const validateListQuery = (raw: ExecutionListQuery): ValidatedExecutionListQuery => {
  const args = asObject('execution.list', raw);
  const since = optionalFiniteNumber('execution.list', args.since, 'since');
  const until = optionalFiniteNumber('execution.list', args.until, 'until');
  if (since !== undefined && until !== undefined && since > until) {
    throw new RpcError('bad_request', 'execution.list: since must be <= until', 400);
  }
  const out: ValidatedExecutionListQuery = {
    limit: clampLimit(args.limit),
  };
  const status = optionalStatusFilter('execution.list', args.status);
  const origin = optionalActorFilter(args.origin);
  const recipeId = optionalString('execution.list', args.recipe_id, 'recipe_id');
  const triggerSource = optionalString(
    'execution.list',
    args.trigger_source,
    'trigger_source',
  );
  const cursor = optionalCursor('execution.list', args.cursor);
  if (status) out.status = status;
  if (origin) out.origin = origin;
  if (recipeId) out.recipe_id = recipeId;
  if (triggerSource) out.trigger_source = triggerSource;
  if (since !== undefined) out.since = since;
  if (until !== undefined) out.until = until;
  if (cursor) out.cursor = cursor;
  return out;
};

const requireRunId = (method: string, raw: unknown): string => {
  const args = asObject(method, raw);
  if (typeof args.run_id !== 'string' || args.run_id.length === 0) {
    throw new RpcError('bad_request', `${method}: run_id is required`, 400);
  }
  return args.run_id;
};

const derivePolicyResult = (entry: AuditEntry): PolicyResult => {
  if (entry.commit_status === 'awaiting_approval') return 'approval-requested';
  const out = entry.output_string?.toLowerCase() ?? '';
  if (out.includes('approval:allow')) return 'released-after-approval';
  if (out.includes('approval:deny')) return 'denied';
  return 'allowed';
};

const BLOCKED_COMMIT_STATUSES: ReadonlySet<CommitStatus> = new Set([
  'failed',
  'cancelled',
  'in_doubt',
]);

const commitDecision = (commit: Commit): RunGatewayCallDecision =>
  BLOCKED_COMMIT_STATUSES.has(commit.status) ? 'blocked' : 'allowed';

const commitPolicyResult = (commit: Commit): PolicyResult =>
  commitDecision(commit) === 'blocked' ? 'blocked' : 'allowed';

const policyResultFromCommits = (
  entry: AuditEntry,
  commits: readonly Commit[],
): PolicyResult => {
  if (commits.length === 0) return derivePolicyResult(entry);
  return commits.some((commit) => commitPolicyResult(commit) === 'blocked')
    ? 'blocked'
    : 'allowed';
};

const projectGatewayTrace = (
  commits: readonly Commit[],
): RunGatewayCallTraceEntry[] =>
  commits.map((commit) => {
    const row: RunGatewayCallTraceEntry = {
      commit_id: commit.commit_id,
      kind: commit.kind,
      ingredient: commit.ingredient,
      tool: commit.tool,
      decision: commitDecision(commit),
      verdict: commit.status,
      dispatched_at: commit.dispatched_at,
    };
    if (commit.completed_at !== undefined) row.completed_at = commit.completed_at;
    if (commit.duration_ms !== undefined) row.duration_ms = commit.duration_ms;
    if (commit.cached === true) row.cached = true;
    return row;
  });

const deriveApprovalOutcome = (
  output: string | undefined,
): RunApprovalOutcome | undefined => {
  const out = output?.toLowerCase() ?? '';
  if (out.includes('approval:dismiss_unseen')) return 'dismiss_unseen';
  if (out.includes('approval:dismiss')) return 'dismiss';
  if (out.includes('approval:allow')) return 'allow';
  if (out.includes('approval:deny')) return 'deny';
  if (out.includes('approval:edit')) return 'edit';
  return undefined;
};

const projectOrigin = (entry: AuditEntry): RunOrigin => {
  const source = entry.execution_source;
  const origin: RunOrigin = source
    ? {
        actor: source.actor,
        label: renderActorLabel(source),
        channel: source.channel,
      }
    : { actor: 'system', label: 'system' };
  const attribution = provenanceAttributionFromSource(
    source,
    entry.contract_snapshot,
  );
  if (attribution) origin.attribution = attribution;
  return origin;
};

const projectLinks = (
  rows: readonly AuditExportLinkRow[],
): RunProvenanceLink[] =>
  rows.map((row) => ({
    entity_id: row.entity_id,
    kind: row.kind,
    ts: row.ts,
  }));

const bucketLinksByRun = (
  rows: readonly AuditExportLinkRow[],
): Map<string, AuditExportLinkRow[]> => {
  const out = new Map<string, AuditExportLinkRow[]>();
  for (const row of rows) {
    const bucket = out.get(row.memory_id);
    if (bucket) bucket.push(row);
    else out.set(row.memory_id, [row]);
  }
  return out;
};

/** D-182 — the reason the run's first cli (`kind: 'cli'`) step failed, for the
 *  feed chip. Derived structurally from the `cli_failure` carrier the executor
 *  attaches (never a message-match); undefined for a non-cli failure. The full
 *  stderr/exit detail rides the detail summary's `errors[].details.cli_failure`. */
const cliFailureReasonOf = (entry: AuditEntry): CliFailureReason | undefined => {
  for (const err of entry.errors) {
    const detail = err.details?.cli_failure;
    if (isCliFailureDetail(detail)) return detail.reason;
  }
  return undefined;
};

const projectRunFeedRow = (
  entry: AuditEntry,
  links: readonly AuditExportLinkRow[],
  commits: readonly Commit[],
): RunFeedRow => {
  // D-182 — a long-op `error_category` (kill / stall / timeout) WINS the single
  // feed chip: a cli error from a SIGKILLed subprocess is the kill's CONSEQUENCE,
  // not an independent tool fault, so don't show "tool error" beside "killed". The
  // full cli detail still rides the detail summary's `errors[].details.cli_failure`.
  const cliFailureReason = entry.error_category === undefined
    ? cliFailureReasonOf(entry)
    : undefined;
  return {
    run_id: entry.run_id,
    recipe_id: entry.recipe_id,
    name: entry.recipe_id,
    started_at: entry.started_at,
    finished_at: entry.finished_at,
    duration_ms: entry.duration_ms,
    origin: projectOrigin(entry),
    status: entry.commit_status,
    policy_result: policyResultFromCommits(entry, commits),
    links: projectLinks(links),
    // D-181 §12 — long-op display category, persisted verbatim on the anchor.
    ...(entry.error_category !== undefined ? { error_category: entry.error_category } : {}),
    // D-182 — cli failure reason for the feed chip (disjoint from error_category).
    ...(cliFailureReason !== undefined ? { cli_failure_reason: cliFailureReason } : {}),
  };
};

const projectAuditSummary = (entry: AuditEntry): RunAuditSummary => {
  const out: RunAuditSummary = {
    run_id: entry.run_id,
    recipe_id: entry.recipe_id,
    recipe_hash: entry.recipe_hash,
    started_at: entry.started_at,
    finished_at: entry.finished_at,
    duration_ms: entry.duration_ms,
    status: entry.commit_status,
    origin: projectOrigin(entry),
    trigger_source: entry.trigger_source,
    instance_id: entry.instance_id,
    errors: entry.errors,
  };
  if (entry.error_category !== undefined) out.error_category = entry.error_category;
  if (entry.output_string !== undefined) out.output_string = entry.output_string;
  if (entry.run_mode !== undefined) out.run_mode = entry.run_mode;
  if (entry.process_id !== undefined) out.process_id = entry.process_id;
  if (entry.recipe_insight_id !== undefined) {
    out.recipe_insight_id = entry.recipe_insight_id;
  }
  if (entry.channel_session_id !== undefined) {
    out.channel_session_id = entry.channel_session_id;
  }
  if (entry.cognition_session_id !== undefined) {
    out.cognition_session_id = entry.cognition_session_id;
  }
  if (entry.correlation_id !== undefined) out.correlation_id = entry.correlation_id;
  if (entry.checkpoint_id !== undefined) out.checkpoint_id = entry.checkpoint_id;
  if (entry.ask_id !== undefined) out.ask_id = entry.ask_id;
  if (entry.degraded !== undefined && entry.degraded.length > 0) {
    out.degraded = [...entry.degraded];
  }
  return out;
};

const projectCheckpoint = (checkpoint: Checkpoint): RunApprovalCheckpoint => {
  // D-182 §8 — the caller filters raw-op (recipe-less) checkpoints OUT before
  // mapping, so a checkpoint reaching here is recipe-bound and the `isCheckpoint`
  // guard guarantees `recipe_id` / `gated_step_id` (the `!`s assert that).
  const out: RunApprovalCheckpoint = {
    checkpoint_id: checkpoint.checkpoint_id,
    run_id: checkpoint.run_id,
    recipe_id: checkpoint.recipe_id!,
    gated_step_id: checkpoint.gated_step_id!,
    created_at: checkpoint.created_at,
  };
  if (checkpoint.approved_target !== undefined) {
    out.approved_target = checkpoint.approved_target as RunApprovalCheckpoint['approved_target'];
  }
  return out;
};

const matchesListFilter = (
  entry: AuditEntry,
  query: ValidatedExecutionListQuery,
): boolean => {
  if (query.status && !query.status.includes(entry.commit_status)) return false;
  if (
    query.origin
    && !query.origin.includes(entry.execution_source?.actor ?? 'system')
  ) {
    return false;
  }
  if (
    query.trigger_source !== undefined
    && entry.trigger_source !== query.trigger_source
  ) {
    return false;
  }
  return true;
};

const cursorFromEntry = (entry: AuditEntry): ExecutionListCursor => ({
  last_started_at: entry.started_at,
  last_run_id: entry.run_id,
});

const exportDeps = (deps: ExecutionFeedRpcDeps): AuditExportRpcDeps => ({
  db: deps.db,
  auditLog: deps.auditLog,
  serverInstanceId: deps.serverInstanceId,
});

export const handleExecutionList = async (
  deps: ExecutionFeedRpcDeps,
  raw: ExecutionListQuery,
): Promise<ExecutionListResponse> => {
  const query = validateListQuery(raw);
  const source = makeServerExportSource(exportDeps(deps));
  const wanted = query.limit + 1;
  const matches: AuditEntry[] = [];
  let scanCursor = query.cursor;
  let exhausted = false;
  let guard = 0;

  while (matches.length < wanted && !exhausted) {
    const pageSize = Math.max(Math.min(MAX_LIMIT, wanted * 4), wanted);
    const page = await source.fetchEntries({
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.until !== undefined ? { until: query.until } : {}),
      ...(query.recipe_id !== undefined ? { recipe_id: query.recipe_id } : {}),
      page_size: pageSize,
      ...(scanCursor ? { cursor: scanCursor } : {}),
    });
    if (page.length === 0) break;
    for (const entry of page) {
      if (matchesListFilter(entry, query)) {
        matches.push(entry);
        if (matches.length === wanted) break;
      }
    }
    const lastScanned = page[page.length - 1]!;
    scanCursor = cursorFromEntry(lastScanned);
    exhausted = page.length < pageSize;
    guard += 1;
    if (guard > 1000) {
      throw new RpcError('internal', 'execution.list: pagination scan did not converge', 500);
    }
  }

  const pageEntries = matches.slice(0, query.limit);
  const [links, commitPages] = pageEntries.length === 0
    ? [[], []] as const
    : await Promise.all([
        source.fetchLinks(pageEntries.map((entry) => entry.run_id)),
        Promise.all(pageEntries.map((entry) => deps.commitStore.listByRun(entry.run_id))),
      ]);
  const linksByRun = bucketLinksByRun(links);
  const commitsByRun = new Map<string, readonly Commit[]>();
  pageEntries.forEach((entry, index) => {
    commitsByRun.set(entry.run_id, commitPages[index] ?? []);
  });
  const runs = pageEntries.map((entry) =>
    projectRunFeedRow(
      entry,
      linksByRun.get(entry.run_id) ?? [],
      commitsByRun.get(entry.run_id) ?? [],
    ),
  );
  const response: ExecutionListResponse = { runs };
  if (matches.length > query.limit && pageEntries.length > 0) {
    response.next_cursor = cursorFromEntry(pageEntries[pageEntries.length - 1]!);
  }
  return response;
};

export const handleExecutionGet = async (
  deps: ExecutionFeedRpcDeps,
  raw: ExecutionGetRequest,
): Promise<ExecutionGetResponse> => {
  const runId = requireRunId('execution.get', raw);
  const entry = await deps.auditLog.get(runId);
  if (!entry) {
    throw new RpcError('not_found', `execution.get: run '${runId}' not found`, 404);
  }
  const source = makeServerExportSource(exportDeps(deps));
  const [linkRows, checkpoints, commits] = await Promise.all([
    source.fetchLinks([runId]),
    deps.checkpointStore.listByRun(runId),
    deps.commitStore.listByRun(runId),
  ]);
  const approvalOutcome = deriveApprovalOutcome(entry.output_string);
  const detail: RunDetail = {
    audit: projectAuditSummary(entry),
    approvals: {
      // D-182 §8 — the recipe-run approval feed lists recipe checkpoints only.
      // A raw-op door checkpoint is recipe-less + anchorless (it has no
      // recipe-run `AuditEntry`, so `execution.get` 404s for its run_id and it
      // never shares a recipe run's run_id); filter it out defensively so the
      // recipe-shaped projection never sees a recipe-less row.
      checkpoints: checkpoints.filter((c) => c.raw_op === undefined).map(projectCheckpoint),
      ...(entry.ask_id !== undefined ? { ask_id: entry.ask_id } : {}),
      ...(entry.checkpoint_id !== undefined ? { checkpoint_id: entry.checkpoint_id } : {}),
      ...(approvalOutcome !== undefined ? { outcome: approvalOutcome } : {}),
      ...(entry.output_string !== undefined ? { output_string: entry.output_string } : {}),
    },
    errors: entry.errors,
    links: projectLinks(linkRows),
    gateway: {
      policy_result: policyResultFromCommits(entry, commits),
      per_call_trace: projectGatewayTrace(commits),
    },
  };
  return { run: detail };
};

type ExecutionFeedMethods = 'execution.list' | 'execution.get';

export const makeExecutionFeedHandlers = (
  deps: ExecutionFeedRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ExecutionFeedMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['execution.list', 'execution.get'],
    handlers: {
      'execution.list': async (args, client) => {
        requireRegisteredClient(client);
        return handleExecutionList(deps, args as ExecutionListQuery);
      },
      'execution.get': async (args, client) => {
        requireRegisteredClient(client);
        return handleExecutionGet(deps, args as ExecutionGetRequest);
      },
    },
  };
};
