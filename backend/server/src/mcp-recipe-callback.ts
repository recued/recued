/** Durable, bounded recipe -> MCP callback hints.
 *
 * A callback is deliberately not a result and carries no authority.  A recipe
 * writes one coalescing hint per (token, topic, query tool); a capable stdio MCP
 * transport emits the hint and its structurally pointer-shaped arguments as an
 * unsolicited notification, and the client must call the named recipe through
 * the ordinary MCP tool gate to read the current answer.  Free-form strings,
 * nested objects, arrays, and content-like argument names are rejected at this
 * boundary; the transport never attaches a query result on its own.  The
 * mailbox lives in the existing data.shared backing store, so this adds no
 * product table and cannot grow with every event.
 *
 * Values are compare-and-set controlled.  That gives the transport a durable
 * delivery marker without a read/send/delete race: enqueue advances the row to
 * a fresh callback_ref, delivery advances the same row with delivered_at, and
 * a concurrent enqueue wins or conflicts rather than being deleted by the old
 * delivery.  A crash between send and the marker can duplicate a hint; the
 * opaque callback_ref exists so clients can dedupe that normal at-least-once
 * edge.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  isMcpInboundTokenActive,
  isMcpInboundTokenToolAuthorized,
  type McpInboundTokenRecord,
} from '@recued/contracts';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import { createOutboxDelivery, type OutboxFamily } from './durable-outbox.js';
import {
  SharedCompareAndSetConflictError,
  type SharedRecord,
  type SharedStore,
} from './storage/shared-store.js';

export const MCP_RECIPE_CALLBACK_NOTIFICATION_METHOD =
  'notifications/recued/recipe-callback';
export const MCP_RECIPE_CALLBACK_CAPABILITY = 'com.recued/recipe-callbacks';

export const MCP_RECIPE_CALLBACK_SCHEMA_VERSION = 1 as const;
export const MCP_RECIPE_CALLBACK_AUTHOR_ID = 'kernel:mcp-recipe-callback';
export const MCP_RECIPE_CALLBACK_KEY_PREFIX = 'mcp.recipe-callback';

export const MCP_RECIPE_CALLBACK_DEFAULT_TTL_SECONDS = 6 * 60 * 60;
export const MCP_RECIPE_CALLBACK_MIN_TTL_SECONDS = 60;
export const MCP_RECIPE_CALLBACK_MAX_TTL_SECONDS = 24 * 60 * 60;

const MAX_ARGUMENTS_JSON_BYTES = 2 * 1024;
const MAX_ARGUMENT_STRING_LENGTH = 256;
const MAX_ARGUMENT_KEYS = 16;
const MAX_ARGUMENT_NUMBER_MAGNITUDE = 1_000_000_000_000;
const MAX_ENQUEUE_ATTEMPTS = 5;

/** Callback arguments are a closed, flat pointer/settings vocabulary. This is
 * an egress boundary, not merely a size optimization: allowing arbitrary JSON
 * would let a recipe put mail content in the notification and bypass the
 * destination contract's later query/read gates. */
export type McpRecipeCallbackArgument = string | number | boolean;

const POINTER_ARGUMENT_KEY = /(?:_id|_ref|_slug|_key|_mode|_kind)$/;
const NUMERIC_ARGUMENT_KEY = /^(?:(?:min|max)_[a-z][a-z0-9_]*|[a-z][a-z0-9_]*(?:_seconds|_minutes|_hours|_days|_count|_limit|_threshold|_confidence|_window|_version))$/;
const BOOLEAN_ARGUMENT_KEY = /^(?:(?:include|allow|require|use)_[a-z][a-z0-9_]*|[a-z][a-z0-9_]*_enabled)$/;
const POINTER_ARGUMENT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const FORBIDDEN_ARGUMENT_SEGMENTS = new Set([
  'address',
  'bearer',
  'body',
  'content',
  'email',
  'message',
  'name',
  'password',
  'prompt',
  'query',
  'result',
  'secret',
  'subject',
  'text',
  'token',
]);

export interface McpRecipeCallbackPointer {
  schema_version: typeof MCP_RECIPE_CALLBACK_SCHEMA_VERSION;
  /** Mirrors SharedStore.cas_revision and is required by its CAS contract. */
  revision: number;
  callback_ref: string;
  target_token_id: string;
  target_contract_id: string;
  topic: string;
  query_tool: string;
  arguments: Record<string, McpRecipeCallbackArgument>;
  triggered_at: number;
  expires_at: number;
  source_recipe_id: string;
  /** Set only after the notification was written to an MCP transport. */
  delivered_callback_ref?: string;
  delivered_at?: number;
}

/** Minimal terminal value retained in the CAS row after a callback leaves its
 * retention window or its token can no longer receive it. Keeping the revision
 * fence prevents a delete/recreate ABA race while removing every callback
 * argument, contract id, recipe id, timestamp, and delivery reference. */
export interface RetiredMcpRecipeCallbackPointer {
  schema_version: typeof MCP_RECIPE_CALLBACK_SCHEMA_VERSION;
  revision: number;
  retired: true;
  retired_at: number;
}

export interface McpRecipeCallbackNotificationParams {
  callback_ref: string;
  topic: string;
  query_tool: string;
  arguments: Record<string, McpRecipeCallbackArgument>;
  triggered_at: number;
  expires_at: number;
}

export interface EnqueueMcpRecipeCallbackInput {
  destination_contract_id: string;
  topic: string;
  query_tool: string;
  arguments: unknown;
  ttl_seconds?: number;
  source_recipe_id: string;
}

export interface EnqueueMcpRecipeCallbackResult {
  queued_to: number;
  failed_to: number;
  coalesced: true;
  skipped_reason:
    | 'destination_contract_inactive'
    | 'destination_contract_not_mcp_enabled'
    | 'no_active_granted_destination'
    | null;
}

export interface EnqueueMcpRecipeCallbackDeps {
  store: Pick<SharedStore, 'list' | 'read' | 'compareAndSet'>;
  inboundTokenStore: Pick<ChatInboundTokenStore, 'listTokens' | 'getTokenById'>;
  isContractLive(contract_id: string): boolean;
  permitsMcpDoor?(contract_id: string): boolean;
  now?: () => number;
  newCallbackRef?: () => string;
}

export interface LiveMcpTokenToolAuthorizerDeps {
  inboundTokenStore: Pick<ChatInboundTokenStore, 'getTokenById'>;
  token_id: string;
  /** The binding carried when this long-lived transport was authenticated.
   * A later rebind must require a reconnect, never silently change identity. */
  initial_contract_id: string | null;
  isContractLive(contract_id: string): boolean;
  permitsMcpDoor(contract_id: string): boolean;
  now?: () => number;
}

/** Re-resolve a long-lived MCP transport's token for every catalog/call check.
 * This keeps revocation, grants, and the contract door live without allowing an
 * in-place rebind to switch the identity of an already-authenticated process. */
export const createLiveMcpTokenToolAuthorizer = (
  deps: LiveMcpTokenToolAuthorizerDeps,
): ((tool_name: string) => boolean) => (tool_name) => {
  try {
    const current = deps.inboundTokenStore.getTokenById(deps.token_id);
    if (
      current === null
      || (current.contract_id ?? null) !== deps.initial_contract_id
      || !isMcpInboundTokenToolAuthorized(current, tool_name, deps.now?.() ?? Date.now())
    ) {
      return false;
    }
    return deps.initial_contract_id === null
      || (
        deps.isContractLive(deps.initial_contract_id)
        && deps.permitsMcpDoor(deps.initial_contract_id)
      );
  } catch {
    return false;
  }
};

export class McpRecipeCallbackInputError extends Error {
  constructor(message: string) {
    super(`mcp_recipe_callback_invalid: ${message}`);
    this.name = 'McpRecipeCallbackInputError';
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const normalizeMcpRecipeCallbackArguments = (
  value: unknown,
): Record<string, McpRecipeCallbackArgument> => {
  if (!isPlainRecord(value)) {
    throw new McpRecipeCallbackInputError('arguments must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ARGUMENT_KEYS) {
    throw new McpRecipeCallbackInputError(
      `arguments exceed the ${MAX_ARGUMENT_KEYS}-key pointer limit`,
    );
  }
  const normalized: Record<string, McpRecipeCallbackArgument> = Object.create(null);
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new McpRecipeCallbackInputError(
        `arguments.${key} is not a lower-snake-case pointer/settings name`,
      );
    }
    const segments = key.split('_');
    if (segments.some((segment) => FORBIDDEN_ARGUMENT_SEGMENTS.has(segment))) {
      throw new McpRecipeCallbackInputError(
        `arguments.${key} names content or credential data, which callbacks cannot carry`,
      );
    }
    if (typeof item === 'string') {
      if (!POINTER_ARGUMENT_KEY.test(key)) {
        throw new McpRecipeCallbackInputError(
          `arguments.${key} must use a pointer/slug/mode/kind key for a string value`,
        );
      }
      if (
        item.length === 0
        || item.length > MAX_ARGUMENT_STRING_LENGTH
        || !POINTER_ARGUMENT_VALUE.test(item)
      ) {
        throw new McpRecipeCallbackInputError(
          `arguments.${key} must be a non-empty ${MAX_ARGUMENT_STRING_LENGTH}-character identifier`,
        );
      }
      normalized[key] = item;
      continue;
    }
    if (typeof item === 'number') {
      if (
        !NUMERIC_ARGUMENT_KEY.test(key)
        || !Number.isFinite(item)
        || Math.abs(item) > MAX_ARGUMENT_NUMBER_MAGNITUDE
      ) {
        throw new McpRecipeCallbackInputError(
          `arguments.${key} must be a bounded numeric threshold/window setting`,
        );
      }
      normalized[key] = item;
      continue;
    }
    if (typeof item === 'boolean' && BOOLEAN_ARGUMENT_KEY.test(key)) {
      normalized[key] = item;
      continue;
    }
    throw new McpRecipeCallbackInputError(
      `arguments.${key} must be a flat pointer identifier or bounded numeric/boolean setting`,
    );
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARGUMENTS_JSON_BYTES) {
    throw new McpRecipeCallbackInputError(
      `arguments exceed the ${MAX_ARGUMENTS_JSON_BYTES}-byte callback limit`,
    );
  }
  return JSON.parse(serialized) as Record<string, McpRecipeCallbackArgument>;
};

const assertIdentifier = (
  value: string,
  label: string,
  maxLength: number,
  pattern: RegExp,
): void => {
  if (value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    throw new McpRecipeCallbackInputError(`${label} is invalid`);
  }
};

const validateEnqueueInput = (
  input: EnqueueMcpRecipeCallbackInput,
): {
  destination_contract_id: string;
  topic: string;
  query_tool: string;
  arguments: Record<string, McpRecipeCallbackArgument>;
  ttl_seconds: number;
  source_recipe_id: string;
} => {
  assertIdentifier(
    input.destination_contract_id,
    'destination_contract_id',
    256,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  );
  assertIdentifier(input.topic, 'topic', 128, /^[a-z][a-z0-9._-]*$/);
  assertIdentifier(
    input.query_tool,
    'query_tool',
    256,
    /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/,
  );
  assertIdentifier(
    input.source_recipe_id,
    'source_recipe_id',
    128,
    /^[a-z][a-z0-9-]*$/,
  );
  const ttl_seconds = input.ttl_seconds ?? MCP_RECIPE_CALLBACK_DEFAULT_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttl_seconds)
    || ttl_seconds < MCP_RECIPE_CALLBACK_MIN_TTL_SECONDS
    || ttl_seconds > MCP_RECIPE_CALLBACK_MAX_TTL_SECONDS
  ) {
    throw new McpRecipeCallbackInputError(
      `ttl_seconds must be an integer between ${MCP_RECIPE_CALLBACK_MIN_TTL_SECONDS} and ${MCP_RECIPE_CALLBACK_MAX_TTL_SECONDS}`,
    );
  }
  return {
    destination_contract_id: input.destination_contract_id,
    topic: input.topic,
    query_tool: input.query_tool,
    arguments: normalizeMcpRecipeCallbackArguments(input.arguments),
    ttl_seconds,
    source_recipe_id: input.source_recipe_id,
  };
};

const callbackKey = (
  token_id: string,
  topic: string,
  query_tool: string,
): string => {
  const route = createHash('sha256')
    .update(topic, 'utf8')
    .update('\0', 'utf8')
    .update(query_tool, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `${MCP_RECIPE_CALLBACK_KEY_PREFIX}.${token_id}.${route}`;
};

const callbackPrefix = (token_id?: string): string =>
  token_id === undefined
    ? MCP_RECIPE_CALLBACK_KEY_PREFIX
    : `${MCP_RECIPE_CALLBACK_KEY_PREFIX}.${token_id}`;

const tokenCanReceivePointer = (
  token: McpInboundTokenRecord | null,
  pointer: Pick<
    McpRecipeCallbackPointer,
    'target_token_id' | 'target_contract_id' | 'query_tool'
  > & { triggered_at?: number },
  now: number,
): boolean =>
  token !== null
  && token.token_id === pointer.target_token_id
  // A hard-deleted token id can only be reused through injected/replayed
  // bearer material. Never let a callback from the prior token incarnation
  // cross that delete/reissue boundary.
  && (pointer.triggered_at === undefined || pointer.triggered_at >= token.created_at)
  && (token.contract_id ?? null) === pointer.target_contract_id
  && isMcpInboundTokenToolAuthorized(token, pointer.query_tool, now);

const writePointer = async (
  deps: EnqueueMcpRecipeCallbackDeps,
  key: string,
  build: (revision: number) => McpRecipeCallbackPointer,
): Promise<boolean> => {
  for (let attempt = 0; attempt < MAX_ENQUEUE_ATTEMPTS; attempt += 1) {
    const current = await deps.store.read(key);
    if (current !== null) {
      // A user-authored shared row cannot become a trusted callback merely by
      // matching the value schema.  Only this kernel seam owns the mailbox.
      if (
        current.author_id !== MCP_RECIPE_CALLBACK_AUTHOR_ID
        || current.cas_revision === null
      ) {
        return false;
      }
    }
    const expectedRevision = current?.cas_revision ?? null;
    const revision = expectedRevision === null ? 0 : expectedRevision + 1;
    try {
      await deps.store.compareAndSet(
        key,
        expectedRevision,
        build(revision),
        { author_id: MCP_RECIPE_CALLBACK_AUTHOR_ID },
      );
      return true;
    } catch (error) {
      if (error instanceof SharedCompareAndSetConflictError) continue;
      return false;
    }
  }
  return false;
};

/** Queue a callback hint for every active token bound to the selected contract
 * that explicitly grants the named query recipe.  No match is a normal skipped
 * result, not a recipe failure; the Recued notification branch remains useful
 * even when the optional MCP destination is offline or unconfigured. */
export const enqueueMcpRecipeCallback = async (
  deps: EnqueueMcpRecipeCallbackDeps,
  rawInput: EnqueueMcpRecipeCallbackInput,
): Promise<EnqueueMcpRecipeCallbackResult> => {
  const input = validateEnqueueInput(rawInput);
  if (!deps.isContractLive(input.destination_contract_id)) {
    return {
      queued_to: 0,
      failed_to: 0,
      coalesced: true,
      skipped_reason: 'destination_contract_inactive',
    };
  }
  if (deps.permitsMcpDoor?.(input.destination_contract_id) === false) {
    return {
      queued_to: 0,
      failed_to: 0,
      coalesced: true,
      skipped_reason: 'destination_contract_not_mcp_enabled',
    };
  }

  const now = deps.now?.() ?? Date.now();
  const targets = deps.inboundTokenStore.listTokens().filter((token) =>
    token.contract_id === input.destination_contract_id
    && isMcpInboundTokenActive(token, now)
    && isMcpInboundTokenToolAuthorized(token, input.query_tool, now));
  if (targets.length === 0) {
    return {
      queued_to: 0,
      failed_to: 0,
      coalesced: true,
      skipped_reason: 'no_active_granted_destination',
    };
  }

  let queued_to = 0;
  let failed_to = 0;
  for (const token of targets) {
    // `listTokens()` is only a candidate snapshot. A revoke, expiry, rebind, or
    // grant edit can land while a callback recipe is running, so re-resolve the
    // row immediately before admitting a durable pointer.
    let current: McpInboundTokenRecord | null;
    try {
      current = deps.inboundTokenStore.getTokenById(token.token_id);
    } catch {
      failed_to += 1;
      continue;
    }
    if (!tokenCanReceivePointer(current, {
      target_token_id: token.token_id,
      target_contract_id: input.destination_contract_id,
      query_tool: input.query_tool,
      triggered_at: now,
    }, deps.now?.() ?? Date.now())) {
      continue;
    }
    const key = callbackKey(token.token_id, input.topic, input.query_tool);
    const callback_ref = deps.newCallbackRef?.() ?? `mcpcb_${randomUUID()}`;
    const wrote = await writePointer(deps, key, (revision) => ({
      schema_version: MCP_RECIPE_CALLBACK_SCHEMA_VERSION,
      revision,
      callback_ref,
      target_token_id: token.token_id,
      target_contract_id: input.destination_contract_id,
      topic: input.topic,
      query_tool: input.query_tool,
      arguments: input.arguments,
      triggered_at: now,
      expires_at: now + input.ttl_seconds * 1_000,
      source_recipe_id: input.source_recipe_id,
    }));
    if (!wrote) {
      failed_to += 1;
      continue;
    }

    // Close the opposite ordering of the same race: if lifecycle mutation
    // committed after the preflight but before this CAS, its handler sweeps the
    // row. If its sweep ran just before this CAS, this postflight observes the
    // new token state and retires the late pointer itself.
    try {
      current = deps.inboundTokenStore.getTokenById(token.token_id);
    } catch {
      current = null;
    }
    if (!tokenCanReceivePointer(current, {
      target_token_id: token.token_id,
      target_contract_id: input.destination_contract_id,
      query_tool: input.query_tool,
      triggered_at: now,
    }, deps.now?.() ?? Date.now())) {
      const retired = await sweepMcpRecipeCallbackRetention({
        store: deps.store,
        inboundTokenStore: deps.inboundTokenStore,
        token_id: token.token_id,
        now: deps.now,
      });
      if (retired.failed > 0) failed_to += 1;
      continue;
    }
    queued_to += 1;
  }

  return {
    queued_to,
    failed_to,
    coalesced: true,
    // Targets were authorized above.  A failed CAS/write is a delivery
    // failure, not evidence that the destination disappeared; failed_to is
    // the truthful signal for that branch.
    skipped_reason:
      queued_to === 0 && failed_to === 0
        ? 'no_active_granted_destination'
        : null,
  };
};

const isSafeIntegerAtLeast = (value: unknown, floor: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= floor;

/** Strict parser for rows read back from the shared mailbox. */
export const parseMcpRecipeCallbackPointer = (
  record: SharedRecord,
): McpRecipeCallbackPointer | null => {
  if (
    record.author_id !== MCP_RECIPE_CALLBACK_AUTHOR_ID
    || record.cas_revision === null
    || !isPlainRecord(record.value)
  ) {
    return null;
  }
  const value = record.value;
  if (
    value.schema_version !== MCP_RECIPE_CALLBACK_SCHEMA_VERSION
    || value.revision !== record.cas_revision
    || !isSafeIntegerAtLeast(value.revision, 0)
    || typeof value.callback_ref !== 'string'
    || !/^mcpcb_[A-Za-z0-9-]{8,}$/.test(value.callback_ref)
    || typeof value.target_token_id !== 'string'
    || !/^[a-f0-9]{16}$/.test(value.target_token_id)
    || typeof value.target_contract_id !== 'string'
    || typeof value.topic !== 'string'
    || !/^[a-z][a-z0-9._-]*$/.test(value.topic)
    || typeof value.query_tool !== 'string'
    || !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(value.query_tool)
    || !isPlainRecord(value.arguments)
    || !isSafeIntegerAtLeast(value.triggered_at, 0)
    || !isSafeIntegerAtLeast(value.expires_at, value.triggered_at)
    || typeof value.source_recipe_id !== 'string'
  ) {
    return null;
  }
  if (
    value.delivered_callback_ref !== undefined
    && typeof value.delivered_callback_ref !== 'string'
  ) {
    return null;
  }
  if (value.delivered_at !== undefined && !isSafeIntegerAtLeast(value.delivered_at, 0)) {
    return null;
  }
  try {
    return {
      schema_version: MCP_RECIPE_CALLBACK_SCHEMA_VERSION,
      revision: value.revision,
      callback_ref: value.callback_ref,
      target_token_id: value.target_token_id,
      target_contract_id: value.target_contract_id,
      topic: value.topic,
      query_tool: value.query_tool,
      arguments: normalizeMcpRecipeCallbackArguments(value.arguments),
      triggered_at: value.triggered_at,
      expires_at: value.expires_at,
      source_recipe_id: value.source_recipe_id,
      ...(value.delivered_callback_ref !== undefined
        ? { delivered_callback_ref: value.delivered_callback_ref }
        : {}),
      ...(value.delivered_at !== undefined ? { delivered_at: value.delivered_at } : {}),
    };
  } catch {
    return null;
  }
};

const parseRetiredMcpRecipeCallbackPointer = (
  record: SharedRecord,
): RetiredMcpRecipeCallbackPointer | null => {
  if (
    record.author_id !== MCP_RECIPE_CALLBACK_AUTHOR_ID
    || record.cas_revision === null
    || !isPlainRecord(record.value)
  ) {
    return null;
  }
  const value = record.value;
  if (
    value.schema_version !== MCP_RECIPE_CALLBACK_SCHEMA_VERSION
    || value.revision !== record.cas_revision
    || !isSafeIntegerAtLeast(value.revision, 0)
    || value.retired !== true
    || !isSafeIntegerAtLeast(value.retired_at, 0)
    || Object.keys(value).some((key) => ![
      'schema_version',
      'revision',
      'retired',
      'retired_at',
    ].includes(key))
  ) {
    return null;
  }
  return {
    schema_version: MCP_RECIPE_CALLBACK_SCHEMA_VERSION,
    revision: value.revision,
    retired: true,
    retired_at: value.retired_at,
  };
};

export interface SweepMcpRecipeCallbackRetentionDeps {
  store: Pick<SharedStore, 'list' | 'read' | 'compareAndSet'>;
  inboundTokenStore: Pick<ChatInboundTokenStore, 'getTokenById'>;
  /** Narrow an immediate lifecycle sweep to one token. Omit for the periodic
   * whole-mailbox retention pass. */
  token_id?: string;
  now?: () => number;
}

export interface SweepMcpRecipeCallbackRetentionResult {
  scanned: number;
  retained: number;
  retired: number;
  conflicted: number;
  failed: number;
}

const TOKEN_FROM_CALLBACK_KEY =
  /^mcp\.recipe-callback\.([a-f0-9]{16})(?:\.|$)/;

/** Scrub terminal callback payloads without deleting their CAS generation
 * fence. The periodic form handles TTL and natural token expiry; the narrowed
 * form is also called immediately after grant, binding, revoke, and delete
 * mutations. Conflicts are benign: a concurrent enqueue or lifecycle sweep
 * advanced the row and the next pass re-evaluates that fresh state. */
export const sweepMcpRecipeCallbackRetention = async (
  deps: SweepMcpRecipeCallbackRetentionDeps,
): Promise<SweepMcpRecipeCallbackRetentionResult> => {
  const result: SweepMcpRecipeCallbackRetentionResult = {
    scanned: 0,
    retained: 0,
    retired: 0,
    conflicted: 0,
    failed: 0,
  };
  const now = deps.now?.() ?? Date.now();
  const rows = await deps.store.list(callbackPrefix(deps.token_id));
  const tokenCache = new Map<string, McpInboundTokenRecord | null>();

  for (const row of rows) {
    result.scanned += 1;
    const keyTokenId = TOKEN_FROM_CALLBACK_KEY.exec(row.key)?.[1];
    if (keyTokenId === undefined || (deps.token_id !== undefined && keyTokenId !== deps.token_id)) {
      result.retained += 1;
      continue;
    }

    let record: SharedRecord | null;
    try {
      record = await deps.store.read(row.key);
    } catch {
      result.failed += 1;
      continue;
    }
    if (record === null) continue;
    if (
      record.author_id !== MCP_RECIPE_CALLBACK_AUTHOR_ID
      || record.cas_revision === null
    ) {
      // This namespace is guessable. Never let retention overwrite a row the
      // kernel did not create through its revision-controlled seam.
      result.retained += 1;
      continue;
    }
    if (parseRetiredMcpRecipeCallbackPointer(record) !== null) {
      result.retained += 1;
      continue;
    }

    const pointer = parseMcpRecipeCallbackPointer(record);
    let token = tokenCache.get(keyTokenId);
    if (token === undefined && !tokenCache.has(keyTokenId)) {
      try {
        token = deps.inboundTokenStore.getTokenById(keyTokenId);
      } catch {
        result.failed += 1;
        continue;
      }
      tokenCache.set(keyTokenId, token);
    }
    const shouldRetire =
      pointer === null
      || pointer.target_token_id !== keyTokenId
      || pointer.expires_at <= now
      || !tokenCanReceivePointer(token ?? null, pointer, now);
    if (!shouldRetire) {
      result.retained += 1;
      continue;
    }

    try {
      await deps.store.compareAndSet(
        row.key,
        record.cas_revision,
        {
          schema_version: MCP_RECIPE_CALLBACK_SCHEMA_VERSION,
          revision: record.cas_revision + 1,
          retired: true,
          retired_at: now,
        } satisfies RetiredMcpRecipeCallbackPointer,
        { author_id: MCP_RECIPE_CALLBACK_AUTHOR_ID },
      );
      result.retired += 1;
    } catch (error) {
      if (error instanceof SharedCompareAndSetConflictError) {
        result.conflicted += 1;
      } else {
        result.failed += 1;
      }
    }
  }
  return result;
};

export const projectMcpRecipeCallbackNotification = (
  pointer: McpRecipeCallbackPointer,
): McpRecipeCallbackNotificationParams => ({
  callback_ref: pointer.callback_ref,
  topic: pointer.topic,
  query_tool: pointer.query_tool,
  arguments: pointer.arguments,
  triggered_at: pointer.triggered_at,
  expires_at: pointer.expires_at,
});

export interface McpRecipeCallbackWatcherDeps {
  store: Pick<SharedStore, 'list' | 'read' | 'compareAndSet'>;
  token_id: string;
  authorize(pointer: McpRecipeCallbackPointer): boolean;
  send(params: McpRecipeCallbackNotificationParams): Promise<void> | void;
  now?: () => number;
}

export interface McpRecipeCallbackWatcher {
  poll(): Promise<void>;
  setReady(): void;
}

/** This family's row rules, expressed for the shared delivery loop.
 *
 *  ⛔ EVERY MEMBER IS AN ACCESSOR OVER THE EXISTING SHAPE. The stored value is
 *  byte-identical to what it was before the loop was lifted out — the port is
 *  provable precisely because nothing about the rows moved, and this file's own
 *  tests are the proof. See `durable-outbox.ts` for the five rules the loop
 *  owns and why they are not restated here. */
const recipeCallbackFamily: OutboxFamily<
  McpRecipeCallbackPointer,
  McpRecipeCallbackNotificationParams
> = {
  author_id: MCP_RECIPE_CALLBACK_AUTHOR_ID,
  prefix: (principal) => callbackPrefix(principal),
  parse: (record) => parseMcpRecipeCallbackPointer(record),
  isRetired: (record) => parseRetiredMcpRecipeCallbackPointer(record) !== null,
  principalOf: (pointer) => pointer.target_token_id,
  dedupeRefOf: (pointer) => pointer.callback_ref,
  deliveredRefOf: (pointer) => pointer.delivered_callback_ref,
  expiresAtOf: (pointer) => pointer.expires_at,
  retiredValue: (revision, retired_at) => ({
    schema_version: MCP_RECIPE_CALLBACK_SCHEMA_VERSION,
    revision,
    retired: true,
    retired_at,
  } satisfies RetiredMcpRecipeCallbackPointer),
  deliveredValue: (pointer, revision, delivered_at) => ({
    ...pointer,
    revision,
    delivered_callback_ref: pointer.callback_ref,
    delivered_at,
  }),
  project: (pointer) => projectMcpRecipeCallbackNotification(pointer),
};

/** Build the transport-side watcher separately from stdin/stdout so its
 * coalescing, readiness, and re-authorization behavior can be driven directly
 * in unit tests.
 *
 * The delivery loop itself now lives in `durable-outbox.ts`: this mailbox was
 * its first family, and an MCP `subscriptions/listen` projection or a peer
 * answer is the same loop with a different `project` and a different `send`.
 * The signature is unchanged, so every caller and every test below is untouched
 * by that move. */
export const createMcpRecipeCallbackWatcher = (
  deps: McpRecipeCallbackWatcherDeps,
): McpRecipeCallbackWatcher => createOutboxDelivery(recipeCallbackFamily, {
  store: deps.store,
  principal: deps.token_id,
  authorize: deps.authorize,
  send: deps.send,
  ...(deps.now !== undefined ? { now: deps.now } : {}),
});
