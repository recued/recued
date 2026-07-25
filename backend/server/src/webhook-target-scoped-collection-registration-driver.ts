/** D-201 Slice 9BJ — closed target-scoped endpoint-collection driver.
 *
 * Trusted profile data selects only a connection-bound managed profile with a
 * required registration target and bounded page-number pagination. Provider
 * code remains responsible for target normalization, connection authority,
 * request/response parsing, correlation, ownership, and secret handling.
 * Packs, recipes, owner input, and portable profile descriptors cannot provide
 * executable registration behavior or outbound authority.
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

export interface WebhookTargetScopedCollectionPaginationPreset {
  readonly kind: 'bounded_page_number.v1';
  readonly max_pages: number;
  readonly page_size: number;
}

export interface WebhookTargetScopedCollectionRegistrationDriverPreset {
  readonly kind: 'target_scoped_endpoint_collection.v1';
  readonly profile_id: WebhookProfileId;
  readonly pagination: WebhookTargetScopedCollectionPaginationPreset;
  readonly search_exhausted_message: string;
}

export interface WebhookTargetScopedCollectionSearchPageInput {
  readonly page_number: number;
  readonly page_size: number;
}

export interface WebhookTargetScopedCollectionSearchPage {
  readonly matches: readonly ManagedWebhookEndpointMatch[];
  readonly has_more: boolean;
}

export interface WebhookTargetScopedCollectionLifecycle {
  find(): Promise<readonly ManagedWebhookEndpointMatch[]>;
}

export interface WebhookTargetScopedCollectionRegistrationOperations<
  SearchSession,
> {
  readonly prepareSearch: (
    context: ManagedWebhookRegistrationContext,
  ) => SearchSession | Promise<SearchSession>;
  readonly readSearchPage: (
    context: ManagedWebhookRegistrationContext,
    session: SearchSession,
    page: WebhookTargetScopedCollectionSearchPageInput,
  ) =>
    | WebhookTargetScopedCollectionSearchPage
    | Promise<WebhookTargetScopedCollectionSearchPage>;
  readonly create: (
    context: ManagedWebhookRegistrationContext,
    idempotencyKey: string,
    lifecycle: WebhookTargetScopedCollectionLifecycle,
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

export interface WebhookTargetScopedCollectionRegistrationDriver
  extends WebhookManagedEndpointRegistrationAdapter {
  readonly preset: WebhookTargetScopedCollectionRegistrationDriverPreset;
}

const PRESET_KEYS = new Set([
  'kind',
  'profile_id',
  'pagination',
  'search_exhausted_message',
]);
const PAGINATION_KEYS = new Set(['kind', 'max_pages', 'page_size']);
const OPERATION_KEYS = new Set([
  'prepareSearch',
  'readSearchPage',
  'create',
  'read',
  'update',
  'delete',
]);
const SEARCH_PAGE_KEYS = new Set(['matches', 'has_more']);
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

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
    'webhook target-scoped-collection registration driver: invalid trusted preset',
  );
};

export const compileWebhookTargetScopedCollectionRegistrationDriverPreset = (
  input: WebhookTargetScopedCollectionRegistrationDriverPreset,
): WebhookTargetScopedCollectionRegistrationDriverPreset => {
  const fields = exactDataValues(input, PRESET_KEYS);
  if (
    fields === null ||
    fields.kind !== 'target_scoped_endpoint_collection.v1' ||
    typeof fields.profile_id !== 'string' ||
    typeof fields.search_exhausted_message !== 'string' ||
    fields.search_exhausted_message.length === 0 ||
    fields.search_exhausted_message.length > 256 ||
    !PRINTABLE_ASCII_RE.test(fields.search_exhausted_message)
  ) {
    return invalidPreset();
  }
  const descriptor = webhookProfile(fields.profile_id as WebhookProfileId);
  const paginationFields = exactDataValues(fields.pagination, PAGINATION_KEYS);
  if (descriptor === null) return invalidPreset();
  const target = webhookOwnerProfileSettings(
    descriptor.profile_id,
  ).registration_target;
  if (
    !descriptor.registration_modes.includes('managed_endpoint') ||
    !descriptor.managed_registration_requires_connection ||
    target === null ||
    !target.modes.includes('managed_endpoint') ||
    paginationFields === null ||
    paginationFields.kind !== 'bounded_page_number.v1' ||
    !Number.isSafeInteger(paginationFields.max_pages) ||
    (paginationFields.max_pages as number) < 1 ||
    (paginationFields.max_pages as number) > 100 ||
    !Number.isSafeInteger(paginationFields.page_size) ||
    (paginationFields.page_size as number) < 1 ||
    (paginationFields.page_size as number) > 1_000
  ) {
    return invalidPreset();
  }
  return Object.freeze({
    kind: fields.kind,
    profile_id: descriptor.profile_id,
    pagination: Object.freeze({
      kind: paginationFields.kind,
      max_pages: paginationFields.max_pages as number,
      page_size: paginationFields.page_size as number,
    }),
    search_exhausted_message: fields.search_exhausted_message,
  });
};

const invalidOperations = (): never => {
  throw new Error(
    'webhook target-scoped-collection registration driver: invalid trusted operations',
  );
};

const invalidSearchPage = (): never => {
  throw new WebhookRegistrationAdapterError(
    'upstream_response_invalid',
    'webhook target-scoped-collection driver received an invalid search page',
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

export const createWebhookTargetScopedCollectionRegistrationDriver = <
  SearchSession,
>(
  presetInput: WebhookTargetScopedCollectionRegistrationDriverPreset,
  operationsInput: WebhookTargetScopedCollectionRegistrationOperations<SearchSession>,
): WebhookTargetScopedCollectionRegistrationDriver => {
  const preset =
    compileWebhookTargetScopedCollectionRegistrationDriverPreset(presetInput);
  const operationFields = exactDataValues(operationsInput, OPERATION_KEYS);
  if (
    operationFields === null ||
    [...OPERATION_KEYS].some(
      (key) => typeof operationFields[key] !== 'function',
    )
  ) {
    return invalidOperations();
  }
  type Operations =
    WebhookTargetScopedCollectionRegistrationOperations<SearchSession>;
  const prepareSearch = operationFields.prepareSearch as Operations['prepareSearch'];
  const readSearchPage = operationFields.readSearchPage as Operations['readSearchPage'];
  const create = operationFields.create as Operations['create'];
  const read = operationFields.read as Operations['read'];
  const update = operationFields.update as Operations['update'];
  const remove = operationFields.delete as Operations['delete'];

  const find = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<readonly ManagedWebhookEndpointMatch[]> => {
    const session = await prepareSearch(context);
    const matches: ManagedWebhookEndpointMatch[] = [];
    for (
      let pageNumber = 1;
      pageNumber <= preset.pagination.max_pages;
      pageNumber += 1
    ) {
      const rawPage = await readSearchPage(
        context,
        session,
        Object.freeze({
          page_number: pageNumber,
          page_size: preset.pagination.page_size,
        }),
      );
      const page = exactDataValues(rawPage, SEARCH_PAGE_KEYS);
      const pageMatches = page === null
        ? null
        : snapshotDenseArrayValues(
          page.matches,
          preset.pagination.page_size,
        );
      if (
        page === null ||
        pageMatches === null ||
        typeof page.has_more !== 'boolean'
      ) {
        return invalidSearchPage();
      }
      matches.push(...(pageMatches as ManagedWebhookEndpointMatch[]));
      if (!page.has_more) return matches;
    }
    throw new WebhookRegistrationAdapterError(
      'search_incomplete',
      preset.search_exhausted_message,
    );
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
