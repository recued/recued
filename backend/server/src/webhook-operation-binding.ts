/** D-201 Slice 6B3 — trusted operation-bound callback injection.
 *
 * Portable catalog content names only a logical webhook binding plus an
 * attach/detach intent. This server-only resolver re-derives the installed
 * consumer binding, ingress, paired connection, canonical callback URL, and
 * exact code-backed adapter immediately before provider dispatch. The adapter's
 * owned wire args are forbidden in recipe input, and its result projector is
 * the only value returned to the recipe.
 */

import {
  webhookProfile,
  type WebhookEnvironment,
  type WebhookIngressRecord,
  type WebhookProfileId,
  type RestExecutionBinding,
} from '@recued/contracts';
import type {
  OperationBoundWebhookResolver,
  PreparedOperationBoundWebhookDispatch,
} from '@recued/engine';
import type { WebhookConsumerKind, WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import type { WebhookIngressStore } from './storage/webhook-ingress-store.js';

export type WebhookOperationBindingIntent = 'attach' | 'detach';

export type WebhookOperationBindingErrorCode =
  | 'invalid'
  | 'unsupported'
  | 'binding_unavailable'
  | 'ingress_not_ready'
  | 'connection_mismatch'
  | 'endpoint_unavailable'
  | 'adapter_invalid'
  | 'provider_failed';

export class WebhookOperationBindingError extends Error {
  constructor(
    readonly code: WebhookOperationBindingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookOperationBindingError';
  }
}

export interface WebhookCallbackBindingAdapterContext {
  ingress_id: string;
  profile_id: WebhookProfileId;
  environment: WebhookEnvironment;
  paired_connection_id: string;
  ingredient_slug: string;
  operation_id: string;
  intent: WebhookOperationBindingIntent;
  /** Present only for attach. Detach adapters own their fixed clear value and
   * never need the public URL merely to remove it from a known resource. */
  callback_url: string | null;
}

export interface WebhookCallbackBindingAdapter {
  profile_id: WebhookProfileId;
  ingredient_slug: string;
  operation_id: string;
  intent: WebhookOperationBindingIntent;
  /** Top-level catalog args wholly owned by this adapter. A recipe supplying
   * any of them is rejected; core never resolves conflicts by trusting author
   * precedence. Wire-style keys such as `body.callback_url` are literal. */
  owned_arg_keys: readonly string[];
  /** Attest the complete portable REST binding for this exact operation. The
   * adapter owns the accepted method/path/static request template even though
   * the catalog must carry a serializable copy for ordinary dispatch. */
  validateExecutionBinding(binding: Readonly<RestExecutionBinding>): boolean;
  buildDispatchArgs(
    context: WebhookCallbackBindingAdapterContext,
    args: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Return only the workflow-safe resource/reconciliation result. Provider
   * echoes and request configuration do not pass through by default. */
  projectResult(
    context: WebhookCallbackBindingAdapterContext,
    result: unknown,
    args: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
}

export interface WebhookCallbackBindingRuntimeRegistry {
  get(input: {
    profile_id: WebhookProfileId;
    ingredient_slug: string;
    operation_id: string;
    intent: WebhookOperationBindingIntent;
  }): WebhookCallbackBindingAdapter | null;
}

const ADAPTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const OWNED_ARG_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

const adapterKey = (adapter: Pick<
  WebhookCallbackBindingAdapter,
  'profile_id' | 'ingredient_slug' | 'operation_id' | 'intent'
>): string => [
  adapter.profile_id,
  adapter.ingredient_slug,
  adapter.operation_id,
  adapter.intent,
].join('\u0000');

export const createWebhookCallbackBindingRuntimeRegistry = (
  adapters: readonly WebhookCallbackBindingAdapter[],
): WebhookCallbackBindingRuntimeRegistry => {
  const byKey = new Map<string, WebhookCallbackBindingAdapter>();
  for (const adapter of adapters) {
    const profile = webhookProfile(adapter.profile_id);
    if (!profile || !profile.registration_modes.includes('operation_bound')) {
      throw new Error(
        `D-201 callback adapter profile '${adapter.profile_id}' does not admit operation_bound`,
      );
    }
    if (!ADAPTER_ID_RE.test(adapter.ingredient_slug)
      || !ADAPTER_ID_RE.test(adapter.operation_id)
      || (adapter.intent !== 'attach' && adapter.intent !== 'detach')
      || adapter.owned_arg_keys.length < 1
      || adapter.owned_arg_keys.length > 16
      || new Set(adapter.owned_arg_keys).size !== adapter.owned_arg_keys.length
      || adapter.owned_arg_keys.some((key) => !OWNED_ARG_RE.test(key))
      || typeof adapter.validateExecutionBinding !== 'function') {
      throw new Error('D-201 callback adapter declaration is invalid');
    }
    const key = adapterKey(adapter);
    if (byKey.has(key)) {
      throw new Error(`Duplicate D-201 callback adapter '${key.replaceAll('\u0000', '/')}'`);
    }
    byKey.set(key, adapter);
  }
  return Object.freeze({
    get(input: Parameters<WebhookCallbackBindingRuntimeRegistry['get']>[0]) {
      return byKey.get(adapterKey(input)) ?? null;
    },
  });
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const validCanonicalEndpoint = (value: string, publicId: string): boolean => {
  if (Buffer.byteLength(value, 'utf8') > 4_096 || value.includes('?') || value.includes('#')) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname.endsWith(`/v1/webhooks/${publicId}`)
      && parsed.href === value;
  } catch {
    return false;
  }
};

const scanPlainGraph = (root: unknown, needle: string | null): boolean => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    visited += 1;
    if (visited > 10_000 || depth > 32) {
      throw new WebhookOperationBindingError(
        'adapter_invalid',
        'operation-bound webhook data exceeds the safe graph bound',
      );
    }
    if (typeof value === 'string') {
      if (needle !== null && value.includes(needle)) return true;
      continue;
    }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value !== 'object') {
      throw new WebhookOperationBindingError(
        'adapter_invalid',
        'operation-bound webhook data contains a non-JSON value',
      );
    }
    if (!Array.isArray(value) && !isPlainRecord(value)) {
      throw new WebhookOperationBindingError(
        'adapter_invalid',
        'operation-bound webhook data must be a plain JSON-like graph',
      );
    }
    if (seen.has(value)) {
      throw new WebhookOperationBindingError(
        'adapter_invalid',
        'operation-bound webhook data graph is cyclic',
      );
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string') {
        throw new WebhookOperationBindingError(
          'adapter_invalid',
          'operation-bound webhook data may not contain symbol keys',
        );
      }
      if (Array.isArray(value)) {
        const index = Number(key);
        if (!Number.isSafeInteger(index)
          || index < 0
          || index >= value.length
          || String(index) !== key) {
          throw new WebhookOperationBindingError(
            'adapter_invalid',
            'operation-bound webhook arrays may contain only indexed values',
          );
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new WebhookOperationBindingError(
          'adapter_invalid',
          'operation-bound webhook data may contain only enumerable data properties',
        );
      }
      pending.push({ value: key, depth: depth + 1 });
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  return false;
};

const assertBoundedPlainGraph = (root: unknown): void => {
  scanPlainGraph(root, null);
};

const cloneAndFreezePlainGraph = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezePlainGraph(entry)));
  }
  const clone = Object.create(
    Object.getPrototypeOf(value) === null ? null : Object.prototype,
  ) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    clone[key] = cloneAndFreezePlainGraph((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(clone);
};

export interface WebhookOperationBindingResolverDeps {
  ingressStore: Pick<WebhookIngressStore, 'get'>;
  consumerStore: Pick<WebhookConsumerStore, 'listBindings'>;
  adapters: WebhookCallbackBindingRuntimeRegistry;
  resolveCanonicalEndpoint(
    ingress: WebhookIngressRecord,
  ): string | null | Promise<string | null>;
}

export const createWebhookOperationBindingResolver = (
  deps: WebhookOperationBindingResolverDeps,
): OperationBoundWebhookResolver => async (call): Promise<PreparedOperationBoundWebhookDispatch> => {
  if (!ADAPTER_ID_RE.test(call.ingredient_slug)
    || !ADAPTER_ID_RE.test(call.operation_id)
    || !/^[a-z][a-z0-9_]{0,63}$/.test(call.logical_binding)
    || (call.intent !== 'attach' && call.intent !== 'detach')
    || typeof call.connection_name !== 'string'
    || call.connection_name.trim().length === 0
    || call.connection_name.length > 256
    || !isPlainRecord(call.consumer)
    || Object.keys(call.consumer).sort().join(',') !== 'id,kind'
    || (call.consumer.kind !== 'pack_install' && call.consumer.kind !== 'local_recipe')
    || typeof call.consumer.id !== 'string'
    || call.consumer.id.length === 0
    || call.consumer.id.length > 256
    || /[\u0000-\u001f\u007f]/.test(call.consumer.id)
    || !isPlainRecord(call.args)) {
    throw new WebhookOperationBindingError('invalid', 'operation-bound webhook call is invalid');
  }
  try {
    assertBoundedPlainGraph(call.args);
  } catch {
    throw new WebhookOperationBindingError(
      'invalid',
      'operation-bound webhook arguments must be a bounded plain data graph',
    );
  }
  const consumer: { kind: WebhookConsumerKind; id: string } = call.consumer;
  const matches = deps.consumerStore.listBindings({
    consumer_kind: consumer.kind,
    consumer_id: consumer.id,
  }).filter((binding) => binding.logical_binding === call.logical_binding);
  if (matches.length !== 1
    || (call.intent === 'attach' && !matches[0]!.enabled)) {
    throw new WebhookOperationBindingError(
      'binding_unavailable',
      call.intent === 'attach'
        ? 'operation-bound webhook binding is absent, ambiguous, or disabled'
        : 'operation-bound webhook cleanup binding is absent or ambiguous',
    );
  }
  const binding = matches[0]!;
  const ingress = deps.ingressStore.get(binding.ingress_id);
  const profile = ingress ? webhookProfile(ingress.profile_id) : null;
  if (!ingress
    || !profile
    || binding.required_profile_id !== ingress.profile_id
    || ingress.registration_mode !== 'operation_bound'
    || !profile.registration_modes.includes('operation_bound')
    || ingress.registration_state !== 'not_applicable'
    || ingress.intake_state === 'retired') {
    throw new WebhookOperationBindingError(
      'binding_unavailable',
      'operation-bound webhook ingress is missing or incompatible',
    );
  }
  if (ingress.paired_connection_id !== call.connection_name) {
    throw new WebhookOperationBindingError(
      'connection_mismatch',
      'operation-bound webhook ingress is paired to a different connection',
    );
  }
  if (call.intent === 'attach'
    && ingress.intake_state !== 'enabled'
    && ingress.intake_state !== 'degraded') {
    throw new WebhookOperationBindingError(
      'ingress_not_ready',
      'operation-bound webhook attachment requires enabled local intake',
    );
  }
  if (call.intent === 'detach'
    && ingress.intake_state !== 'enabled'
    && ingress.intake_state !== 'degraded'
    && ingress.intake_state !== 'disabled') {
    throw new WebhookOperationBindingError(
      'ingress_not_ready',
      'operation-bound webhook cleanup requires an attached or disabled ingress',
    );
  }
  const adapter = deps.adapters.get({
    profile_id: ingress.profile_id,
    ingredient_slug: call.ingredient_slug,
    operation_id: call.operation_id,
    intent: call.intent,
  });
  if (!adapter) {
    throw new WebhookOperationBindingError(
      'unsupported',
      'no trusted callback adapter matches this profile and operation',
    );
  }
  let bindingAccepted = false;
  try {
    bindingAccepted = adapter.validateExecutionBinding(call.execution_binding) === true;
  } catch {
    bindingAccepted = false;
  }
  if (!bindingAccepted) {
    throw new WebhookOperationBindingError(
      'adapter_invalid',
      'trusted callback adapter rejected the catalog execution binding',
    );
  }
  for (const key of adapter.owned_arg_keys) {
    if (Object.prototype.hasOwnProperty.call(call.args, key)) {
      throw new WebhookOperationBindingError(
        'invalid',
        `recipe input may not set trusted callback argument '${key}'`,
      );
    }
  }
  let callbackUrl: string | null = null;
  if (call.intent === 'attach') {
    try {
      callbackUrl = await deps.resolveCanonicalEndpoint(ingress);
    } catch {
      throw new WebhookOperationBindingError(
        'endpoint_unavailable',
        'operation-bound webhook callback endpoint is unavailable',
      );
    }
  }
  if (call.intent === 'attach'
    && (typeof callbackUrl !== 'string'
      || !validCanonicalEndpoint(callbackUrl, ingress.public_id))) {
    throw new WebhookOperationBindingError(
      'endpoint_unavailable',
      'operation-bound webhook callback endpoint is unavailable',
    );
  }
  const context: WebhookCallbackBindingAdapterContext = Object.freeze({
    ingress_id: ingress.ingress_id,
    profile_id: ingress.profile_id,
    environment: ingress.environment,
    paired_connection_id: ingress.paired_connection_id,
    ingredient_slug: call.ingredient_slug,
    operation_id: call.operation_id,
    intent: call.intent,
    callback_url: callbackUrl,
  });
  const safeArgs = cloneAndFreezePlainGraph(call.args) as Readonly<Record<string, unknown>>;
  let dispatchArgs: Record<string, unknown>;
  try {
    dispatchArgs = await adapter.buildDispatchArgs(context, safeArgs);
    if (!isPlainRecord(dispatchArgs)
      || adapter.owned_arg_keys.some((key) =>
        !Object.prototype.hasOwnProperty.call(dispatchArgs, key))) {
      throw new Error('invalid dispatch shape');
    }
    const containsCallback = scanPlainGraph(dispatchArgs, callbackUrl);
    if (callbackUrl !== null && !containsCallback) {
      throw new Error('canonical endpoint was not injected');
    }
    dispatchArgs = cloneAndFreezePlainGraph(dispatchArgs) as Record<string, unknown>;
  } catch {
    throw new WebhookOperationBindingError(
      'adapter_invalid',
      'trusted callback adapter could not prepare a bounded dispatch',
    );
  }

  return {
    dispatch_args: dispatchArgs,
    validateDispatchInput(input) {
      const containsCallback = scanPlainGraph(input, callbackUrl);
      for (const key of adapter.owned_arg_keys) {
        if (!Object.prototype.hasOwnProperty.call(input, key)
          || !Object.is(input[key], dispatchArgs[key])) {
          throw new WebhookOperationBindingError(
            'adapter_invalid',
            `trusted callback argument '${key}' was changed during catalog dispatch lowering`,
          );
        }
      }
      if (callbackUrl !== null && !containsCallback) {
        throw new WebhookOperationBindingError(
          'adapter_invalid',
          'catalog dispatch lowering removed the canonical callback endpoint',
        );
      }
    },
    async projectResult(result) {
      try {
        const projected = await adapter.projectResult(context, result, safeArgs);
        const containsCallback = scanPlainGraph(projected, callbackUrl);
        if (callbackUrl !== null && containsCallback) {
          throw new Error('canonical endpoint reached projected output');
        }
        return cloneAndFreezePlainGraph(projected);
      } catch {
        throw new WebhookOperationBindingError(
          'adapter_invalid',
          'trusted callback adapter could not project a bounded recipe result',
        );
      }
    },
    projectError(_error, phase) {
      if (phase === 'dispatch_preparation') {
        return new WebhookOperationBindingError(
          'adapter_invalid',
          'operation-bound dispatch preparation failed without exposing request configuration',
        );
      }
      return new WebhookOperationBindingError(
        'provider_failed',
        'operation-bound provider operation failed without exposing request configuration',
      );
    },
  };
};

export const OPERATION_BOUND_FIXTURE_CATALOG = 'webhook-operation-fixture';
export const OPERATION_BOUND_FIXTURE_ATTACH = 'resource.create';
export const OPERATION_BOUND_FIXTURE_DETACH = 'resource.clear_callback';

const fixtureResultId = (value: unknown): string => {
  const envelope = isPlainRecord(value) ? value : null;
  const result = envelope && isPlainRecord(envelope.result) ? envelope.result : null;
  const id = result?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_:-]{1,256}$/.test(id)) {
    throw new WebhookOperationBindingError(
      'adapter_invalid',
      'operation-bound fixture provider result omitted its remote resource id',
    );
  }
  return id;
};

const fixtureAdapter = (
  operationId: string,
  intent: WebhookOperationBindingIntent,
): WebhookCallbackBindingAdapter => ({
  profile_id: 'generic.static-header-token.v1',
  ingredient_slug: OPERATION_BOUND_FIXTURE_CATALOG,
  operation_id: operationId,
  intent,
  owned_arg_keys: ['body.callback_url'],
  validateExecutionBinding(binding) {
    const expectedMethod = intent === 'attach' ? 'POST' : 'PATCH';
    const expectedPath = intent === 'attach'
      ? '/resources'
      : '/resources/{{resource_id}}';
    return Object.keys(binding).sort().join(',') === 'kind,method,path_template'
      && binding.kind === 'rest'
      && binding.method === expectedMethod
      && binding.path_template === expectedPath;
  },
  buildDispatchArgs(context, args) {
    return {
      ...args,
      'body.callback_url': context.callback_url ?? '',
    };
  },
  projectResult(_context, result, args) {
    const remoteResourceId = fixtureResultId(result);
    if (intent === 'detach' && args.resource_id !== remoteResourceId) {
      throw new WebhookOperationBindingError(
        'adapter_invalid',
        'operation-bound fixture cleanup result did not match the requested resource',
      );
    }
    return {
      remote_resource_id: remoteResourceId,
      webhook_binding_state: intent === 'attach' ? 'attached' : 'detached',
    };
  },
});

/** Code-backed fixture mounted only for the reserved first-party fixture
 * catalog identity. It performs no I/O; the ordinary catalog REST executor is
 * still the provider boundary. */
export const createOperationBoundWebhookFixtureAdapters = (): readonly WebhookCallbackBindingAdapter[] => [
  fixtureAdapter(OPERATION_BOUND_FIXTURE_ATTACH, 'attach'),
  fixtureAdapter(OPERATION_BOUND_FIXTURE_DETACH, 'detach'),
];
