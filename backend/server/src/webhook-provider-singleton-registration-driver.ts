/** D-201 Slice 9BK — closed provider-singleton registration driver.
 *
 * Trusted profile data selects only a targetless connection-bound managed
 * profile. Provider code remains responsible for connection and singleton
 * identity authority, request/response parsing, correlation, ownership,
 * mutations, confirmation, and secret handling. Packs, recipes, owner input,
 * and portable profile descriptors cannot provide executable registration
 * behavior or outbound authority.
 */

import {
  webhookOwnerProfileSettings,
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  WebhookRegistrationAdapterError,
  type ManagedWebhookEndpointCreateResult,
  type ManagedWebhookEndpointMatch,
  type ManagedWebhookEndpointSnapshot,
  type ManagedWebhookRegistrationContext,
  type WebhookManagedEndpointRegistrationAdapter,
} from './webhook-registration-runtime.js';

export interface WebhookProviderSingletonRegistrationDriverPreset {
  readonly kind: 'provider_singleton_endpoint.v1';
  readonly profile_id: WebhookProfileId;
}

export interface WebhookProviderSingletonInspection {
  readonly matches: readonly ManagedWebhookEndpointMatch[];
}

export interface WebhookProviderSingletonLifecycle {
  find(): Promise<readonly ManagedWebhookEndpointMatch[]>;
}

export interface WebhookProviderSingletonRegistrationOperations {
  readonly inspect: (
    context: ManagedWebhookRegistrationContext,
  ) => WebhookProviderSingletonInspection
    | Promise<WebhookProviderSingletonInspection>;
  readonly create: (
    context: ManagedWebhookRegistrationContext,
    idempotencyKey: string,
    lifecycle: WebhookProviderSingletonLifecycle,
  ) => Promise<ManagedWebhookEndpointCreateResult>;
  readonly read: (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ) => Promise<ManagedWebhookEndpointSnapshot | null>;
  readonly update: (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
    idempotencyKey: string,
  ) => Promise<ManagedWebhookEndpointSnapshot>;
  readonly delete: (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ) => Promise<void>;
}

export interface WebhookProviderSingletonRegistrationDriver
  extends WebhookManagedEndpointRegistrationAdapter {
  readonly preset: WebhookProviderSingletonRegistrationDriverPreset;
}

const PRESET_KEYS = new Set(['kind', 'profile_id']);
const OPERATION_KEYS = new Set([
  'inspect',
  'create',
  'read',
  'update',
  'delete',
]);
const INSPECTION_KEYS = new Set(['matches']);

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.length !== keys.size ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))
    ) {
      return null;
    }
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        return null;
      }
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
  }
};

const invalidPreset = (): never => {
  throw new Error(
    'webhook provider-singleton registration driver: invalid trusted preset',
  );
};

export const compileWebhookProviderSingletonRegistrationDriverPreset = (
  input: WebhookProviderSingletonRegistrationDriverPreset,
): WebhookProviderSingletonRegistrationDriverPreset => {
  const fields = exactDataValues(input, PRESET_KEYS);
  if (
    fields === null ||
    fields.kind !== 'provider_singleton_endpoint.v1' ||
    typeof fields.profile_id !== 'string'
  ) {
    return invalidPreset();
  }
  const descriptor = webhookProfile(fields.profile_id as WebhookProfileId);
  if (
    descriptor === null ||
    !descriptor.registration_modes.includes('managed_endpoint') ||
    !descriptor.managed_registration_requires_connection ||
    webhookOwnerProfileSettings(descriptor.profile_id).registration_target
      !== null
  ) {
    return invalidPreset();
  }
  return Object.freeze({
    kind: fields.kind,
    profile_id: descriptor.profile_id,
  });
};

const invalidOperations = (): never => {
  throw new Error(
    'webhook provider-singleton registration driver: invalid trusted operations',
  );
};

const invalidInspection = (): never => {
  throw new WebhookRegistrationAdapterError(
    'upstream_response_invalid',
    'webhook provider-singleton driver received an invalid inspection',
  );
};

const snapshotDenseArrayValues = (
  value: unknown,
  maxValues: number,
): readonly unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maxValues
    ) {
      return null;
    }
    const length = lengthDescriptor.value as number;
    if (Reflect.ownKeys(value).length !== length + 1) return null;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        return null;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
};

export const createWebhookProviderSingletonRegistrationDriver = (
  presetInput: WebhookProviderSingletonRegistrationDriverPreset,
  operationsInput: WebhookProviderSingletonRegistrationOperations,
): WebhookProviderSingletonRegistrationDriver => {
  const preset =
    compileWebhookProviderSingletonRegistrationDriverPreset(presetInput);
  const operationFields = exactDataValues(operationsInput, OPERATION_KEYS);
  if (
    operationFields === null ||
    [...OPERATION_KEYS].some(
      (key) => typeof operationFields[key] !== 'function',
    )
  ) {
    return invalidOperations();
  }
  type Operations = WebhookProviderSingletonRegistrationOperations;
  const inspect = operationFields.inspect as Operations['inspect'];
  const create = operationFields.create as Operations['create'];
  const read = operationFields.read as Operations['read'];
  const update = operationFields.update as Operations['update'];
  const remove = operationFields.delete as Operations['delete'];

  const find = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<readonly ManagedWebhookEndpointMatch[]> => {
    const rawInspection = await inspect(context);
    const inspection = exactDataValues(rawInspection, INSPECTION_KEYS);
    const matches = inspection === null
      ? null
      : snapshotDenseArrayValues(inspection.matches, 1);
    if (inspection === null || matches === null) return invalidInspection();
    return matches as ManagedWebhookEndpointMatch[];
  };

  return Object.freeze({
    preset,
    profile_id: preset.profile_id,
    find,
    create(
      context: ManagedWebhookRegistrationContext,
      idempotencyKey: string,
    ): Promise<ManagedWebhookEndpointCreateResult> {
      return create(
        context,
        idempotencyKey,
        Object.freeze({
          find: () => find(context),
        }),
      );
    },
    read,
    update,
    delete: remove,
  });
};
