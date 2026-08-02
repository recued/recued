/**
 * Versioned, tool-boundary identity for work entities.
 *
 * Internal work-entity ids remain ordinary local row ids. AI-facing reads use
 * this qualified form so a later generic or provider-specific mutation can
 * retain the exact Source choice without asking the model to reconstruct it.
 *
 * Format (every dynamic segment is encodeURIComponent-encoded):
 *
 *   we1:<kind>:<source_id>:source:<source_record_id>
 *   we1:<kind>:<source_id>:local:<local_id>
 *
 * `source` is preferred for mirrored rows because a provider-specific tool can
 * safely unwrap the provider-native record id. `local` is the fallback for a
 * built-in row, or for an external row that has not acquired remote identity.
 */

import type { IngredientManifest } from './ingredient.js';
import {
  isWorkEntityKind,
  type WorkEntityKind,
} from './work-entities.js';
import type {
  WorkEntitySourceDeclaration,
  WorkEntityTargetedOpSlot,
} from './work-entity-sources.js';

export const QUALIFIED_WORK_ENTITY_ID_VERSION = 'we1' as const;
export const QUALIFIED_WORK_ENTITY_ID_PREFIX = `${QUALIFIED_WORK_ENTITY_ID_VERSION}:`;

export type QualifiedWorkEntityIdentityKind = 'source' | 'local';

export interface QualifiedWorkEntityId {
  version: typeof QUALIFIED_WORK_ENTITY_ID_VERSION;
  kind: WorkEntityKind;
  source_id: string;
  identity: QualifiedWorkEntityIdentityKind;
  record_id: string;
}

export type QualifiedWorkEntityIdErrorCode =
  | 'QUALIFIED_ID_INVALID'
  | 'QUALIFIED_ID_KIND_MISMATCH'
  | 'QUALIFIED_ID_CONNECTION_REQUIRED'
  | 'QUALIFIED_ID_LOCAL_ONLY'
  | 'SOURCE_MISMATCH';

export class QualifiedWorkEntityIdError extends Error {
  readonly code: QualifiedWorkEntityIdErrorCode;
  readonly retry_with?: string;
  readonly expected_source?: string;
  readonly actual_source?: string;

  constructor(
    code: QualifiedWorkEntityIdErrorCode,
    message: string,
    detail: {
      retry_with?: string;
      expected_source?: string;
      actual_source?: string;
    } = {},
  ) {
    super(message);
    this.name = 'QualifiedWorkEntityIdError';
    this.code = code;
    if (detail.retry_with !== undefined) this.retry_with = detail.retry_with;
    if (detail.expected_source !== undefined) this.expected_source = detail.expected_source;
    if (detail.actual_source !== undefined) this.actual_source = detail.actual_source;
  }
}

const encodeSegment = (value: string, field: string): string => {
  if (value.length === 0) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      `QUALIFIED_ID_INVALID: ${field} must be a non-empty string.`,
    );
  }
  return encodeURIComponent(value);
};

const decodeSegment = (value: string, field: string): string => {
  if (value.length === 0) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      `QUALIFIED_ID_INVALID: qualified id has an empty ${field} segment.`,
    );
  }
  try {
    const decoded = decodeURIComponent(value);
    // Require one canonical, injective spelling. In particular this rejects
    // malformed percent escapes and alternate encodings of delimiters.
    if (decoded.length === 0 || encodeURIComponent(decoded) !== value) {
      throw new Error('non-canonical encoding');
    }
    return decoded;
  } catch {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      `QUALIFIED_ID_INVALID: qualified id has an invalid ${field} segment.`,
    );
  }
};

export const qualifyWorkEntityId = (input: {
  kind: WorkEntityKind;
  source_id: string;
  source_record_id?: string;
  local_id: string;
}): string => {
  const identity: QualifiedWorkEntityIdentityKind =
    typeof input.source_record_id === 'string' && input.source_record_id.length > 0
      ? 'source'
      : 'local';
  const record_id = identity === 'source' ? input.source_record_id! : input.local_id;
  return [
    QUALIFIED_WORK_ENTITY_ID_VERSION,
    input.kind,
    encodeSegment(input.source_id, 'source_id'),
    identity,
    encodeSegment(record_id, identity === 'source' ? 'source_record_id' : 'local_id'),
  ].join(':');
};

/** Parse a qualified id. Legacy/unqualified ids return `null`; a string that
 * claims the `we1:` namespace but is malformed fails loudly. */
export const parseQualifiedWorkEntityId = (raw: string): QualifiedWorkEntityId | null => {
  if (!raw.startsWith(QUALIFIED_WORK_ENTITY_ID_PREFIX)) return null;
  const parts = raw.split(':');
  if (parts.length !== 5) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      'QUALIFIED_ID_INVALID: expected we1:<kind>:<source_id>:<source|local>:<record_id>.',
    );
  }
  const [version, kindRaw, sourceRaw, identityRaw, recordRaw] = parts;
  if (version !== QUALIFIED_WORK_ENTITY_ID_VERSION || !isWorkEntityKind(kindRaw)) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      `QUALIFIED_ID_INVALID: unknown work-entity kind '${kindRaw ?? ''}'.`,
    );
  }
  if (identityRaw !== 'source' && identityRaw !== 'local') {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      `QUALIFIED_ID_INVALID: identity must be 'source' or 'local', not '${identityRaw ?? ''}'.`,
    );
  }
  return {
    version: QUALIFIED_WORK_ENTITY_ID_VERSION,
    kind: kindRaw,
    source_id: decodeSegment(sourceRaw!, 'source_id'),
    identity: identityRaw,
    record_id: decodeSegment(recordRaw!, 'record_id'),
  };
};

const substituteSourceTemplate = (template: string, connectionName: string): string =>
  template
    .replaceAll('${connection_id}', connectionName)
    .replaceAll('${connection_name}', connectionName);

const TARGETED_SLOTS = ['read', 'update', 'delete', 'complete'] as const satisfies
  readonly WorkEntityTargetedOpSlot[];

interface OperationCandidate {
  declaration: WorkEntitySourceDeclaration;
  slot: WorkEntityTargetedOpSlot;
  id_arg: string;
  expected_source: string;
  exact: boolean;
}

const retryToolFor = (
  manifest: IngredientManifest,
  operation: string,
  kind: WorkEntityKind,
  candidate: Pick<OperationCandidate, 'slot' | 'exact'>,
): string => {
  const risk = manifest.operations?.[operation]?.risk_tier;
  if (risk === 'read') return 'work.read';
  // Only the declaration's exact delete slot proves whole-entity deletion. A
  // sibling name cannot: `task.due_date.remove` removes one field, and routing
  // that mismatch to `data.task.delete` would turn a corrective retry into a
  // destructive action. Provider-specific archive/remove verbs that really do
  // delete must therefore occupy the Source's canonical delete slot.
  if (candidate.exact && candidate.slot === 'delete') return `data.${kind}.delete`;
  return `data.${kind}.update`;
};

const operationCandidates = (
  manifest: IngredientManifest,
  operation: string,
  connectionName: string,
): OperationCandidate[] => {
  const out: OperationCandidate[] = [];
  for (const declaration of manifest.work_entity_sources ?? []) {
    const exactSlots = TARGETED_SLOTS.filter((slot) => declaration.ops[slot] === operation);
    for (const slot of TARGETED_SLOTS) {
      const binding = declaration.op_bindings?.[slot]
        ?? (slot === 'complete' ? declaration.op_bindings?.update : undefined);
      if (binding === undefined || binding.id_arg.length === 0) continue;
      const exact = exactSlots.includes(slot);
      // Provider siblings such as task.move / task.reopen often target the
      // same native id but are not the Source's canonical update slot. Admit
      // the known id_arg only inside the same declared remote-entity family.
      const family = operation === declaration.remote.entity
        || operation.startsWith(`${declaration.remote.entity}.`)
        || operation.startsWith(`${declaration.kind}.`);
      const collectionLevel = declaration.ops.list === operation
        || declaration.ops.create === operation;
      if (!exact && (!family || collectionLevel)) continue;
      out.push({
        declaration,
        slot,
        id_arg: binding.id_arg,
        expected_source: substituteSourceTemplate(
          declaration.source_id_template,
          connectionName,
        ),
        exact,
      });
    }
  }
  // Exact Source slots win over sibling-operation inference. De-duplicate a
  // repeated id_arg/Source pair (read/update commonly share the same id_arg).
  const selected = out.some((candidate) => candidate.exact)
    ? out.filter((candidate) => candidate.exact)
    : out;
  const seen = new Set<string>();
  return selected.filter((candidate) => {
    const key = `${candidate.declaration.kind}\0${candidate.id_arg}\0${candidate.expected_source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export interface QualifiedWorkEntityOperationRouting {
  args: Record<string, unknown>;
  routed?: {
    kind: WorkEntityKind;
    source_id: string;
    source_record_id: string;
    id_arg: string;
    retry_with: string;
  };
}

/**
 * Validate and unwrap a qualified id supplied to one provider operation.
 *
 * Bare provider-native ids remain backward compatible. A qualified id is
 * accepted only for the exact Source instance implied by the catalog
 * declaration plus selected connection. Wrong-provider and wrong-account
 * calls throw `SOURCE_MISMATCH` before approval or network dispatch.
 */
export const routeQualifiedWorkEntityOperationArgs = (input: {
  manifest: IngredientManifest;
  operation: string;
  connection_name: string;
  args: Record<string, unknown>;
}): QualifiedWorkEntityOperationRouting => {
  const candidates = operationCandidates(
    input.manifest,
    input.operation,
    input.connection_name,
  );
  if (candidates.length === 0) return { args: input.args };

  const qualified = candidates.flatMap((candidate) => {
    const raw = input.args[candidate.id_arg];
    if (typeof raw !== 'string' || !raw.startsWith(QUALIFIED_WORK_ENTITY_ID_PREFIX)) {
      return [];
    }
    return [{ candidate, parsed: parseQualifiedWorkEntityId(raw)! }];
  });
  if (qualified.length === 0) return { args: input.args };

  const first = qualified[0]!;
  const retry_with = retryToolFor(
    input.manifest,
    input.operation,
    first.parsed.kind,
    first.candidate,
  );
  const qualifiedArgNames = new Set(
    qualified.map(({ candidate }) => candidate.id_arg),
  );
  if (qualifiedArgNames.size > 1) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_INVALID',
      `QUALIFIED_ID_INVALID: '${input.operation}' received qualified ids in multiple target `
        + `arguments (${[...qualifiedArgNames].join(', ')}). No provider call was made. `
        + `Retry with '${retry_with}' one item at a time.`,
      { retry_with, actual_source: first.parsed.source_id },
    );
  }
  if (input.connection_name.length === 0) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_CONNECTION_REQUIRED',
      `QUALIFIED_ID_CONNECTION_REQUIRED: '${input.operation}' needs an exact connection before `
        + `a qualified id can be routed. No provider call was made. Retry with '${retry_with}' `
        + 'using the same qualified id.',
      { retry_with, actual_source: first.parsed.source_id },
    );
  }

  const kindMatches = qualified.filter(
    ({ candidate, parsed }) => candidate.declaration.kind === parsed.kind,
  );
  if (kindMatches.length === 0) {
    const expectedKinds = [...new Set(qualified.map(({ candidate }) => candidate.declaration.kind))];
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_KIND_MISMATCH',
      `QUALIFIED_ID_KIND_MISMATCH: '${input.operation}' targets ${expectedKinds.join(' or ')}, `
        + `but the id is for ${first.parsed.kind}. No provider call was made. Retry with `
        + `'${retry_with}' using the same qualified id.`,
      { retry_with, actual_source: first.parsed.source_id },
    );
  }

  const sourceMatch = kindMatches.find(
    ({ candidate, parsed }) => candidate.expected_source === parsed.source_id,
  );
  if (sourceMatch === undefined) {
    const expected = [...new Set(kindMatches.map(({ candidate }) => candidate.expected_source))];
    throw new QualifiedWorkEntityIdError(
      'SOURCE_MISMATCH',
      `SOURCE_MISMATCH: '${input.operation}' on connection '${input.connection_name}' accepts `
        + `source '${expected.join("' or '")}', but the id belongs to `
        + `'${first.parsed.source_id}'. No provider call was made. Retry with '${retry_with}' `
        + 'using the same qualified id.',
      {
        retry_with,
        expected_source: expected.join(','),
        actual_source: first.parsed.source_id,
      },
    );
  }
  if (sourceMatch.parsed.identity !== 'source') {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_LOCAL_ONLY',
      `QUALIFIED_ID_LOCAL_ONLY: '${input.operation}' cannot unwrap a local-only id for `
        + `source '${sourceMatch.parsed.source_id}'. No provider call was made. Retry with `
        + `'${retry_with}' using the same qualified id.`,
      {
        retry_with,
        expected_source: sourceMatch.candidate.expected_source,
        actual_source: sourceMatch.parsed.source_id,
      },
    );
  }

  return {
    args: {
      ...input.args,
      [sourceMatch.candidate.id_arg]: sourceMatch.parsed.record_id,
    },
    routed: {
      kind: sourceMatch.parsed.kind,
      source_id: sourceMatch.parsed.source_id,
      source_record_id: sourceMatch.parsed.record_id,
      id_arg: sourceMatch.candidate.id_arg,
      retry_with,
    },
  };
};
