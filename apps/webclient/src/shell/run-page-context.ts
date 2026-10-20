/** In-memory page selections shared with the Run palette. Routes supply loaded
 * records; neither URL tails nor rendered text are treated as record data. */
import {
  deriveRecipeTargeting,
  isAssetDate,
  isRecipePageBinding,
  isRecordOutputSource,
  isListOfNumbers,
  listFromTypedText,
  listSettingChoices,
  recordFieldsSource,
  type ServerRecipeListEntry,
  type VariableDefault,
  type RecordOutputSource,
} from '@recued/contracts';

export interface RunPageObject {
  readonly kind: string;
  readonly id: string | number;
  readonly label: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** Records identities belong to one pack's namespace. */
  readonly owner?: { readonly publisher: string; readonly pack_slug: string };
  /** Vendor identity domains carried by rendered API results. Local page
   * objects have none; their IDs are not vendor IDs of the same kind. */
  readonly platforms?: readonly string[];
  /** A rendered API result whose source has not been attested by its host.
   * A recipe's supported_platforms is compatibility metadata, not provenance. */
  readonly origin?: 'api';
  readonly apiSource?: RecordOutputSource;
}

export interface RunPageContext {
  readonly label: string;
  readonly objects: readonly RunPageObject[];
}

export interface RunPageContextProvider {
  getRunPageContext?(): RunPageContext | null;
}

interface PageConnectionSlot {
  readonly slot: string;
  readonly connections: readonly { readonly connection_name: string; readonly connection_revision?: string }[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const own = (value: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const usableKey = (key: string): boolean =>
  key !== 'id' && !key.startsWith('_') && key !== 'constructor' && key !== 'prototype';

export const runPageObject = (
  kind: string,
  id: string | number,
  values: Readonly<Record<string, unknown>>,
  owner?: RunPageObject['owner'],
): RunPageObject => ({
  kind, id, values,
  label: ['name', 'title', 'label', 'subject', 'filename', 'email']
    .map(key => own(values, key))
    .find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? String(id),
  ...(owner === undefined ? {} : { owner }),
});

/** Freeze the opener's selection before inventory reads or background refreshes
 * can replace it. An unavailable selection leaves the ordinary Run form intact. */
export const snapshotRunPageContext = (read?: () => RunPageContext | null): RunPageContext | null => {
  try {
    const context = read?.();
    if (!context || context.objects.length === 0) return null;
    return JSON.parse(JSON.stringify(context)) as RunPageContext;
  } catch {
    return null;
  }
};

const recipeOwner = (entry: ServerRecipeListEntry): string | undefined =>
  entry.recipe.metadata?.recipe_bundle;
const sharesOwner = (object: RunPageObject, entry: ServerRecipeListEntry): boolean =>
  object.owner === undefined
    || recipeOwner(entry) === `${object.owner.publisher}/${object.owner.pack_slug}`;

const empty = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
const fileRef = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('file:') && value.length > 'file:'.length;

/** Keep the recipe's declared defaults; page values only seed missing inputs.
 * Credential, connection, and setup fields are never inferred from a record. */
const fitsVariable = (declaration: VariableDefault, value: unknown): boolean => {
  if (empty(value)) return false;
  const hint = record(declaration);
  if (hint && !empty(hint.default)) return false;
  if (!hint && !empty(declaration)) return false;
  const type = hint?.type;
  switch (type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && Array.isArray(hint?.options) && hint.options.includes(value);
    case 'array': {
      if (!Array.isArray(value)) return false;
      const choices = listSettingChoices(declaration);
      const numbers = choices ? choices.choices.every(choice => typeof choice.value === 'number')
        : isListOfNumbers(hint?.default);
      if (choices) return value.every(item => choices.choices.some(choice => choice.value === item));
      // The open list control displays comma-separated text. Only use values
      // its own reader preserves, including scalar types and item boundaries.
      return JSON.stringify(listFromTypedText(value.map(String).join(', '), { numbers })) === JSON.stringify(value);
    }
    case 'object': return record(value) !== null;
    case 'json': return true;
    case 'secret': case 'oauth': case 'connection': case 'mail_template': case 'file_slug': return false;
    case 'date': return isAssetDate(value);
    case 'datetime': return typeof value === 'string' && isAssetDate(value.slice(0, 10))
      && /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && Number.isFinite(Date.parse(value));
    case 'file_ref': return fileRef(value);
    case 'file_ref[]': return Array.isArray(value) && value.every(fileRef);
    case 'long_text': return typeof value === 'string';
    case 'text': case 'string': case 'url': case 'record_ref':
      return typeof value === 'string' && !/[\r\n]/.test(value);
    default: return empty(declaration) && typeof value === 'string' && !/[\r\n]/.test(value);
  }
};

/** A named field or an explicitly typed record reference supplies an argument.
 * Bare `id` is deliberately not guessed: two recipes can use it for different
 * kinds. Multiple distinct candidates leave a field for the owner to choose. */
export const recipePagePrefill = (
  entry: ServerRecipeListEntry,
  context: RunPageContext | null,
  connectionSlots: readonly PageConnectionSlot[] = [],
): { config: Record<string, unknown>; context: Record<string, unknown>; source: string | null;
  connections?: Record<string, string>;
  connectionRevisions?: Record<string, string>;
  connectionFields?: Record<string, { config: string[]; context: string[] }> } => {
  const config: Record<string, unknown> = {};
  const targetContext: Record<string, unknown> = {};
  const used = new Set<string>();
  const connections: Record<string, string> = Object.create(null);
  const connectionRevisions: Record<string, string> = Object.create(null);
  const connectionFields: Record<string, { config: string[]; context: string[] }> = Object.create(null);
  const variables = entry.recipe.variables ?? {};
  const objects = context?.objects.filter(object => sharesOwner(object, entry)) ?? [];
  const sourceConnections = new Map<RunPageObject, { slot: string; name: string; revision: string }>();
  const accounts = new Map<string, Set<string>>();
  for (const object of objects) {
    const source = object.apiSource;
    if (!isRecordOutputSource(source) || !source.connection_revision || source.entity !== object.kind) continue;
    const slots = connectionSlots.filter(slot => slot.connections.some(connection =>
      connection.connection_name === source.connection_name
        && connection.connection_revision === source.connection_revision));
    if (slots.length !== 1) continue;
    const slot = slots[0]!.slot;
    sourceConnections.set(object, { slot, name: source.connection_name, revision: source.connection_revision });
    const names = accounts.get(slot) ?? new Set<string>();
    names.add(source.connection_name);
    accounts.set(slot, names);
  }
  const valueFor = (key: string, declaration?: VariableDefault, textTarget = false): unknown => {
    const hint = record(declaration);
    const binding = hint?.page_binding;
    // A broken or unavailable explicit binding must not fall back to a
    // same-named field from some other kind of object.
    if (binding !== undefined && !isRecipePageBinding(binding)) return undefined;
    if (!usableKey(key) && !(key === 'id' && (hint?.type === 'record_ref' || binding !== undefined))) return undefined;
    const candidates: Array<{ value: unknown; label: string; platform?: string;
      connection?: { slot: string; name: string; revision: string } }> = [];
    for (const object of objects) {
      if (binding !== undefined && object.kind !== binding.kind) continue;
      const platforms = entry.recipe.metadata?.supported_platforms ?? [];
      const sourcePlatforms = object.apiSource ? [object.apiSource.platform] : object.platforms ?? [];
      const connection = sourceConnections.get(object);
      if (object.origin === 'api' || object.apiSource !== undefined || sourcePlatforms.length > 0) {
        if (!connection || accounts.get(connection.slot)?.size !== 1) continue;
      }
      if (binding !== undefined && (binding.platform
        ? !sourcePlatforms.includes(binding.platform) : sourcePlatforms.length > 0)) continue;
      const durableFile = hint?.type === 'file_ref' || hint?.type === 'file_ref[]';
      // Vendor IDs cannot establish an identity in Recued's file store.
      if (durableFile && (object.origin === 'api' || object.apiSource !== undefined)) continue;
      if (binding === undefined && object.owner === undefined && !durableFile
        && (platforms.length > 0 ? !platforms.some(platform => sourcePlatforms.includes(platform)) : sourcePlatforms.length > 0)) continue;
      let value: unknown;
      if (hint?.type === 'record_ref') {
        // The hint's entity and pack namespace are the picker's own contract.
        if (!object.owner || object.kind !== hint.entity) continue;
        const scope = record(hint.entity_filter) ?? {};
        if (!Object.entries(scope).every(([field, expected]) => own(object.values, field) === expected)) continue;
        const slots = Object.values(variables).filter(variable => {
          const other = record(variable);
          return other?.type === 'record_ref' && other.entity === object.kind;
        }).length;
        if (binding !== undefined && (binding.kind !== hint.entity || binding.field !== 'id')) continue;
        if (binding === undefined && slots > 1 && key !== `${object.kind}_id` && key !== `${object.kind}_ref` && key !== object.kind) continue;
        value = object.id;
      } else if (binding !== undefined) {
        value = binding.field === 'id' ? object.id : binding.field.split('.').reduce<unknown>(
          (parent, field) => { const row = record(parent); return row ? own(row, field) : undefined; },
          object.values,
        );
      } else if (key === object.kind && (hint?.type === 'object' || hint?.type === 'json')) {
        value = Object.fromEntries(Object.entries(object.values)
          .filter(([field]) => !field.startsWith('_') && field !== 'constructor' && field !== 'prototype'));
      } else {
        value = own(object.values, key);
        if (value === undefined && (key === `${object.kind}_id`
          || (key === 'file_ref' && object.kind === 'file'))) value = object.id;
        if (value === undefined && key.startsWith(`${object.kind}_`)) {
          value = own(object.values, key.slice(object.kind.length + 1));
        }
      }
      if (value === undefined || value === null || value === '') continue;
      // Target inputs have no declared value schema and edit strings. Keep
      // other JSON values manual rather than adding an uneditable prefill.
      if (textTarget && (typeof value !== 'string' || /[\r\n]/.test(value))) continue;
      if (declaration !== undefined && !fitsVariable(declaration, value)) continue;
      candidates.push({ value, label: object.label, ...(connection ? { connection,
        platform: object.apiSource!.platform } : {}) });
    }
    const distinct = new Set(candidates.map(candidate => JSON.stringify([
      candidate.value, candidate.platform, candidate.connection,
    ])));
    if (distinct.size !== 1) return undefined;
    for (const candidate of candidates) {
      used.add(candidate.label);
      if (candidate.connection) {
        const { slot, name, revision } = candidate.connection;
        connections[slot] = name;
        connectionRevisions[slot] = revision;
        const fields = connectionFields[slot] ?? { config: [], context: [] };
        const keys = textTarget ? fields.context : fields.config;
        if (!keys.includes(key)) keys.push(key);
        connectionFields[slot] = fields;
      }
    }
    return candidates[0]!.value;
  };
  for (const [key, declaration] of Object.entries(variables)) {
    const value = valueFor(key, declaration);
    if (value !== undefined) config[key] = value;
  }
  const targets = new Set([
    ...(entry.run_context_targets ?? []),
    ...deriveRecipeTargeting(entry.recipe).targets.filter(target => target.kind === 'context').map(target => target.key),
  ]);
  for (const key of targets) {
    const value = valueFor(key, undefined, true);
    if (value !== undefined) targetContext[key] = value;
  }
  return { config, context: targetContext, source: used.size > 0 ? [...used].join(', ') : null,
    ...(Object.keys(connections).length > 0 ? { connections, connectionRevisions, connectionFields } : {}) };
};

/** A rendered record_fields block carries both the entity and the actual row.
 * Tables and result history are not selections and cannot seed a run. */
export const runPageContextFromOutput = (
  sections: readonly { type: string; data: unknown; [key: string]: unknown }[],
  entry: ServerRecipeListEntry | undefined,
): RunPageContext | null => {
  if (!entry) return null;
  const bundle = recipeOwner(entry)?.split('/');
  const owner = bundle?.length === 2 && bundle[0] && bundle[1]
    ? { publisher: bundle[0], pack_slug: bundle[1] } : undefined;
  const objects: RunPageObject[] = [];
  for (const section of sections) {
    if (section.type !== 'record_fields') continue;
    const descriptor = record(section.record_fields);
    const row = recordFieldsSource(section.data);
    if (!descriptor || descriptor.unresolved || !row || typeof descriptor.entity !== 'string') continue;
    // Resolved fields carry friendly names even when the source uses vendor
    // paths. Use the same values the page actually shows.
    const values = { ...row };
    for (const rawField of Array.isArray(descriptor.fields) ? descriptor.fields : []) {
      const field = record(rawField);
      if (field?.present === true && typeof field.key === 'string' && usableKey(field.key)) {
        values[field.key] = field.value;
      }
    }
    const id = own(values, 'id') ?? own(values, '_id') ?? own(values, `${descriptor.entity}_id`);
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    if (id === '' || (typeof id === 'number' && !Number.isFinite(id))) continue;
    // API record_fields blocks share this renderer with Records rows. Only a
    // Records metadata envelope establishes a pack-owned picker identity.
    const apiSource = isRecordOutputSource(section.record_source)
      && section.record_source.entity === descriptor.entity ? section.record_source : undefined;
    const recordsOwner = section.record_source === undefined && record(row._record)?.entity === descriptor.entity
      ? owner : undefined;
    objects.push({ ...runPageObject(descriptor.entity, id, values, recordsOwner),
      ...(recordsOwner ? {} : { origin: 'api' as const }),
      ...(apiSource ? { apiSource } : {}),
    });
  }
  return objects.length > 0 ? { label: objects.map(object => object.label).join(', '), objects } : null;
};
