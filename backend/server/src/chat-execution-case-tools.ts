/** Chat-only D-214 metadata tools and server-side span finalization. */

import { randomUUID } from 'node:crypto';
import {
  OWNER_CONTRACT_ID,
  executionSourceContractId,
  isOutcomeClaim,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type InternalToolRegistry,
  type OutcomeReportArgs,
  type ToolEntry,
  type ToolTier,
} from '@recued/contracts';

import {
  hashExecutionCaseValue,
} from './execution-case-core.js';
import {
  policyFingerprintForSpan,
  type ExecutionCaseCompiler,
} from './execution-case-compiler.js';
import {
  EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY,
  readConsultedExecutionCaseKeys,
} from './execution-case-retrieval.js';
import type {
  ExecutionReportStore,
} from './storage/execution-report-store.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';
import {
  parseRequestDissection,
  type ExecutionSpanDissectionStore,
} from './storage/execution-span-dissection-store.js';
import type {
  CaseInterventionStore,
} from './storage/case-intervention-store.js';
import { insertToolEntryAfterTier1 } from './chat-tools-search.js';

export const OUTCOME_REPORT_TOOL_NAME = 'outcome.report';
export const REQUEST_DISSECTION_TOOL_NAME = 'request.dissection';

export const OUTCOME_REPORT_TOOL_ENTRY: ToolEntry = {
  name: OUTCOME_REPORT_TOOL_NAME,
  tier: 1,
  description:
    'After substantive governed tool work reaches its terminal outcome, report '
    + 'whether the initiating request was fulfilled. This is a completion '
    + 'marker, not evidence or permission. Call at most once. If approval or a '
    + 'run is still pending, wait until it resolves.',
  arg_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      claim: {
        type: 'string',
        enum: ['fulfilled', 'partial', 'unfulfilled', 'unknown'],
      },
      open_items: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', maxLength: 512 },
      },
    },
    required: ['claim'],
  },
  topic_tags: ['outcome', 'completion', 'internal'],
  classification: 'read',
  concurrency_safe: false,
};

/** Classification metadata emitted alongside ordinary tool proposals in the
 * same model response. It carries no hash, outcome, identity, or scope. */
export const REQUEST_DISSECTION_TOOL_ENTRY: ToolEntry = {
  name: REQUEST_DISSECTION_TOOL_NAME,
  tier: 1,
  description:
    'When the current user request requires governed tools, emit this '
    + 'classification alongside the first proposed tool call. Describe only '
    + 'what the user asked, never what tools happened to run. In intent, reuse '
    + 'the root request’s action/object words in their original order; do not '
    + 'paraphrase or supply only a generic noun. Do not include ids, hashes, '
    + 'permission, or outcome claims.',
  arg_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      schema_version: { type: 'number', enum: [1] },
      intent: { type: 'string', maxLength: 512 },
      objects: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', maxLength: 512 },
      },
      entities: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', maxLength: 128 },
            kind: { type: 'string', maxLength: 128 },
          },
          required: ['role', 'kind'],
        },
      },
      constraints: {
        type: 'array',
        maxItems: 16,
        items: { type: 'string', maxLength: 512 },
      },
      outcome_sought: { type: 'string', maxLength: 512 },
    },
    required: [
      'schema_version',
      'intent',
      'objects',
      'entities',
      'constraints',
      'outcome_sought',
    ],
  },
  topic_tags: ['request', 'classification', 'internal'],
  classification: 'read',
  concurrency_safe: false,
};

export const parseOutcomeReportArgs = (
  raw: unknown,
): OutcomeReportArgs | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some((key) =>
      key !== 'claim' && key !== 'open_items')
    || !isOutcomeClaim(value.claim)
  ) return null;
  if (value.open_items === undefined) return { claim: value.claim };
  if (!Array.isArray(value.open_items) || value.open_items.length > 16) {
    return null;
  }
  const openItems: string[] = [];
  for (const item of value.open_items) {
    if (
      typeof item !== 'string'
      || Buffer.byteLength(item, 'utf8') > 512
    ) return null;
    openItems.push(item);
  }
  return { claim: value.claim, open_items: openItems };
};

export interface ExecutionCaseLifecycleDeps {
  anchorStore: ExecutionSpanAnchorStore;
  dissectionStore: ExecutionSpanDissectionStore;
  reportStore: ExecutionReportStore;
  compiler: ExecutionCaseCompiler;
  registry: InternalToolRegistry;
  interventionStore?: CaseInterventionStore;
  now?: () => number;
  newReportId?: () => string;
}

export interface ExecutionCaseLifecycle {
  dispatchOutcome(
    raw: unknown,
    context: ChatDispatchContext,
  ): Promise<ChatDispatchResult>;
  dispatchDissection(
    raw: unknown,
    context: ChatDispatchContext,
  ): Promise<ChatDispatchResult>;
  finalizeTurn(input: {
    session_id: string;
    turn_id: string;
    state?: Map<string, unknown>;
  }): Promise<void>;
  markPlannerEgress(state: Map<string, unknown>, at: number): void;
  recordPlannerRounds(input: {
    session_id: string;
    turn_id: string;
    rounds: number;
  }): void;
}

const contextScope = (
  context: ChatDispatchContext,
): { governing_contract_id: string; principal_key: string } => {
  const source = context.execution_source;
  const contractId = source
    ? executionSourceContractId(source)
    : undefined;
  if (source?.actor === 'contracted_user') {
    return {
      governing_contract_id: contractId ?? '',
      principal_key:
        'user_id' in source
          ? `contracted_user:${source.user_id}`
          : 'contracted_user',
    };
  }
  return {
    governing_contract_id: contractId ?? OWNER_CONTRACT_ID,
    principal_key: 'user_self',
  };
};

const invalidArgs = (detail: string): ChatDispatchResult => ({
  ok: false,
  reason: 'invalid_args',
  detail,
});

export const createExecutionCaseLifecycle = (
  deps: ExecutionCaseLifecycleDeps,
): ExecutionCaseLifecycle => {
  const now = deps.now ?? Date.now;
  const reportId = deps.newReportId ?? (() => randomUUID());

  const consultedCaseKeys = async (
    root_request_id: string,
    state?: Map<string, unknown>,
  ): Promise<string[]> => {
    const keys = new Set(readConsultedExecutionCaseKeys(state));
    if (deps.interventionStore) {
      for (
        const key of await deps.interventionStore
          .shownCaseKeysForRoot(root_request_id)
      ) {
        keys.add(key);
      }
    }
    return [...keys].sort();
  };

  const policyFingerprint = (
    root_request_id: string,
    governing_contract_id: string,
  ): string => {
    const span = deps.compiler.resolveSpan(root_request_id);
    return policyFingerprintForSpan({
      governing_contract_id,
      tools: [
        ...span.activities.map((item) => item.tool_name),
        ...span.plans.map((item) => item.tool),
      ],
      registry: deps.registry,
      authorization_applied:
        governing_contract_id !== OWNER_CONTRACT_ID
        || span.plans.length > 0
        || span.activities.some((item) =>
          item.reason === 'classification_blocked'
          || item.reason === 'contract_denied'
          || item.reason === 'policy_denied'
          || item.reason === 'destructive_denied'
          || item.reason === 'channel_denied')
        || span.recipe_runs.some((item) =>
          item.contract_snapshot !== undefined),
      contract_snapshots: span.recipe_runs.flatMap((item) =>
        item.contract_snapshot === undefined ? [] : [item.contract_snapshot]),
    });
  };

  const closeAndCompile = async (
    id: string,
    root_request_id: string,
    governing_contract_id: string,
    state?: Map<string, unknown>,
  ): Promise<void> => {
    const span = deps.compiler.resolveSpan(root_request_id);
    if (span.pending) return;
    const consulted_case_keys = await consultedCaseKeys(
      root_request_id,
      state,
    );
    const closed = await deps.reportStore.close(id, {
      closed_at: now(),
      first_event_id: span.first_event_id,
      last_event_id: span.last_event_id,
      policy_fingerprint: policyFingerprint(
        root_request_id,
        governing_contract_id,
      ),
      consulted_case_keys,
    });
    if (closed) {
      await deps.compiler.compileReport(id);
      deps.interventionStore?.markSpanClosed(root_request_id, now());
    }
  };

  return {
    markPlannerEgress(state, at) {
      const value = state.get(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY);
      if (!(value instanceof Set)) return;
      // The set is a queue for the next model-bound packet, not a turn-wide
      // exposure flag. Consume it before writing so later packets cannot
      // inherit an earlier advisory.
      state.delete(EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY);
      for (const id of value) {
        if (typeof id === 'string') {
          try {
            deps.interventionStore?.markPlannerEgress(id, at);
          } catch (error) {
            console.error('[d214] planner-egress attribution failed', error);
          }
        }
      }
    },

    recordPlannerRounds(input) {
      const root = deps.anchorStore.resolveRoot(
        input.session_id,
        input.turn_id,
      );
      if (!root) return;
      try {
        deps.interventionStore?.recordPlannerRounds({
          root_request_id: root,
          session_id: input.session_id,
          turn_id: input.turn_id,
          rounds: input.rounds,
        });
      } catch (error) {
        console.error('[d214] planner-round attribution failed', error);
      }
    },

    async dispatchDissection(raw, context) {
      if (!context.session_id || !context.turn_id) {
        return invalidArgs('request.dissection is chat-only');
      }
      const parsed = parseRequestDissection(raw);
      if (!parsed) return invalidArgs('invalid request dissection');
      const root = deps.anchorStore.resolveRoot(
        context.session_id,
        context.turn_id,
      );
      if (!root) {
        return {
          ok: true,
          result: {
            recorded: false,
            guidance: 'No anchored governed request; continue the turn.',
          },
        };
      }
      const recordedAt = now();
      const [recorded, rootRecorded] = await Promise.all([
        deps.dissectionStore.putForTurn(
          root,
          context.session_id,
          context.turn_id,
          parsed,
          recordedAt,
        ),
        deps.dissectionStore.putFirst(
          root,
          parsed,
          recordedAt,
        ),
      ]);
      return {
        ok: true,
        result: {
          recorded: recorded || rootRecorded,
          guidance:
            'Classification recorded. Continue with the requested work; do not '
            + 'call request.dissection again in this turn.',
        },
      };
    },

    async dispatchOutcome(raw, context) {
      if (!context.session_id || !context.turn_id) {
        return invalidArgs('outcome.report is chat-only');
      }
      const parsed = parseOutcomeReportArgs(raw);
      if (!parsed) {
        return invalidArgs(
          'outcome.report accepts only claim and optional open_items',
        );
      }
      const rootRequestId = deps.compiler.resolveRootForClose(
        context.session_id,
        context.turn_id,
      );
      if (!rootRequestId) {
        return {
          ok: true,
          result: {
            recorded: false,
            admitted: false,
            guidance: 'No anchored governed flow; finish without retrying.',
          },
        };
      }
      const existing = await deps.reportStore.listForRoot(rootRequestId);
      if (existing.length > 0) {
        return {
          ok: true,
          result: {
            recorded: true,
            admitted: false,
            deferred: existing.some((item) => item.closed_at === undefined),
            guidance: 'Outcome already recorded; do not call again.',
          },
        };
      }
      const rootRequest = await deps.anchorStore.readRootRequest(rootRequestId);
      if (rootRequest === undefined) {
        return {
          ok: true,
          result: {
            recorded: false,
            admitted: false,
            guidance: 'The source request is unavailable; do not retry.',
          },
        };
      }
      const span = deps.compiler.resolveSpan(rootRequestId);
      const scope = contextScope(context);
      const id = reportId();
      const reportedAt = now();
      const consulted_case_keys = await consultedCaseKeys(
        rootRequestId,
        context.turn_state,
      );
      await deps.reportStore.putImmutable({
        report_id: id,
        execution_span_id:
          `span_${hashExecutionCaseValue(rootRequestId).slice(0, 32)}`,
        root_request_id: rootRequestId,
        session_id: context.session_id,
        governing_contract_id: scope.governing_contract_id,
        principal_key: scope.principal_key,
        policy_fingerprint: policyFingerprint(
          rootRequestId,
          scope.governing_contract_id,
        ),
        root_request: rootRequest,
        first_event_id: span.first_event_id,
        last_event_id: span.last_event_id,
        model_claim: parsed.claim,
        open_items: parsed.open_items ?? [],
        consulted_case_keys,
        reported_at: reportedAt,
        pending_reason:
          span.pending
            ? 'correlated_work_pending'
            : 'turn_finalization_pending',
      });
      return {
        ok: true,
        result: {
          recorded: true,
          admitted: false,
          deferred: true,
          guidance:
            span.pending
              ? 'Recorded; closure will wait for the correlated work. Do not retry.'
              : 'Recorded; the server will close it after the current turn. Do not retry.',
        },
      };
    },

    async finalizeTurn(input) {
      const rootRequestId = deps.compiler.resolveRootForClose(
        input.session_id,
        input.turn_id,
      );
      if (!rootRequestId) return;
      const span = deps.compiler.resolveSpan(rootRequestId);
      if (span.pending) return;
      // Experiment closure is an observed turn/span fact, not conditional on
      // best-effort model reporting or on a strong learning signal. Otherwise
      // ordinary no-report successes are misclassified as instrumentation
      // attrition.
      deps.interventionStore?.markSpanClosed(rootRequestId, now());
      const existing = await deps.reportStore.listForRoot(rootRequestId);
      const pending = existing.find((item) => item.closed_at === undefined);
      if (pending) {
        await closeAndCompile(
          pending.report.report_id,
          rootRequestId,
          pending.report.governing_contract_id,
          input.state,
        );
        return;
      }
      // Weak negatives need a durable source envelope too: without one,
      // independent cancelled/superseded/expired roots can never accumulate to
      // the recurrence floor. This still does not admit them early; the pure
      // compiler retains the three-root gate.
      if (existing.length > 0 || !span.has_compilable_signal) return;
      const root = deps.anchorStore.getRoot(rootRequestId);
      const rootRequest = await deps.anchorStore.readRootRequest(rootRequestId);
      if (!root || rootRequest === undefined) return;
      const id =
        `server_${hashExecutionCaseValue([
          rootRequestId,
          span.last_event_id,
        ]).slice(0, 32)}`;
      const at = now();
      const consulted_case_keys = await consultedCaseKeys(
        rootRequestId,
        input.state,
      );
      await deps.reportStore.putImmutable({
        report_id: id,
        execution_span_id:
          `span_${hashExecutionCaseValue(rootRequestId).slice(0, 32)}`,
        root_request_id: rootRequestId,
        session_id: root.session_id,
        governing_contract_id: OWNER_CONTRACT_ID,
        principal_key: 'user_self',
        policy_fingerprint: policyFingerprint(
          rootRequestId,
          OWNER_CONTRACT_ID,
        ),
        root_request: rootRequest,
        first_event_id: span.first_event_id,
        last_event_id: span.last_event_id,
        model_claim: 'unknown',
        open_items: [],
        consulted_case_keys,
        reported_at: at,
        closed_at: at,
        server_finalized: true,
      });
      await deps.compiler.compileReport(id);
      deps.interventionStore?.markSpanClosed(rootRequestId, at);
    },
  };
};

export const wrapRegistryWithExecutionCaseTools = (
  inner: InternalToolRegistry,
  lifecycle: ExecutionCaseLifecycle,
): InternalToolRegistry => {
  const entries = [
    REQUEST_DISSECTION_TOOL_ENTRY,
    OUTCOME_REPORT_TOOL_ENTRY,
  ];
  const list = (): ToolEntry[] => entries.reduce(
    (current, entry) => insertToolEntryAfterTier1(current, entry),
    [...inner.list()],
  );
  return {
    list,
    listByTier: (tier: ToolTier) =>
      tier === 1 ? [...inner.listByTier(1), ...entries] : inner.listByTier(tier),
    getByName: (name) =>
      entries.find((entry) => entry.name === name) ?? inner.getByName(name),
    dispatch: (name, args, context) =>
      name === OUTCOME_REPORT_TOOL_NAME
        ? lifecycle.dispatchOutcome(args, context)
        : name === REQUEST_DISSECTION_TOOL_NAME
          ? lifecycle.dispatchDissection(args, context)
          : inner.dispatch(name, args, context),
    subscribeRefresh: (callback) => inner.subscribeRefresh(callback),
  };
};
